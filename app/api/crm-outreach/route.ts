import { NextRequest,NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { getCurrentWorkspaceContext,canManageWorkspace } from '@/lib/workspace-access';
import { importComments,event,enabled } from '@/lib/crm-outreach/service';
import { eligibleComment,openReplyWindow } from '@/lib/crm-outreach/rules';
export const dynamic='force-dynamic';
export const maxDuration=300;
const input=z.object({action:z.enum(['import','pilot','start','pause','resume','do_not_contact','remove','approve','retry','survey_completed']),accountId:z.string().min(1).optional(),campaignId:z.string().min(1).optional(),mediaIds:z.array(z.string().regex(/^\d+$/)).min(1).max(25).optional(),leadIds:z.array(z.string().min(1)).min(1).max(5).optional(),leadId:z.string().min(1).optional(),confirmed:z.boolean().optional()});
export async function GET(req:NextRequest) {
  const context=await getCurrentWorkspaceContext();if(!context)return NextResponse.json({error:'Unauthorized'},{status:401});
  if(!canManageWorkspace(context.role))return NextResponse.json({error:'Forbidden'},{status:403});
  const accounts=await prisma.instagramAccount.findMany({where:{workspaceId:context.workspaceId},select:{id:true,username:true,instagramId:true}});
  const accountId=req.nextUrl.searchParams.get('accountId')||accounts[0]?.id;
  const campaign=await prisma.crmOutreachCampaign.findFirst({where:{workspaceId:context.workspaceId,instagramAccountId:accountId||'',name:'pesquisa_semente_crm'}});
  if(!campaign)return NextResponse.json({accounts,campaign:null,leads:[],counts:{},enabled:enabled()});
  const where={campaignId:campaign.id};
  if(req.nextUrl.searchParams.get('export')==='csv') {
    const lines=['id;instagram_user_id;username;status;reason;first_sent_at;last_reply_at;survey_sent_at;survey_completed_at;duplicate_count'];
    let cursor:string|undefined;
    for(;;) {
      const rows=await prisma.crmOutreachLead.findMany({where,orderBy:{id:'asc'},take:500,...(cursor?{cursor:{id:cursor},skip:1}:{})});
      for(const r of rows)lines.push([r.id,r.commenterId,r.username,r.status,r.reason,r.firstSentAt?.toISOString(),r.lastReplyAt?.toISOString(),r.surveySentAt?.toISOString(),r.surveyCompletedAt?.toISOString(),r.duplicateCount].map(v=>{const s=String(v??'');return '"'+(/^[=+\-@\t\r]/.test(s)?"'":"")+s.replaceAll('"','""')+'"';}).join(';'));
      if(rows.length<500)break;cursor=rows.at(-1)!.id;
    }
    return new NextResponse('\uFEFF'+lines.join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="pesquisa-semente-crm.csv"','Cache-Control':'no-store'}});
  }
  const status=req.nextUrl.searchParams.get('status')||undefined;
  const page=Math.max(0,Math.min(100000,Number(req.nextUrl.searchParams.get('page'))||0));
  const [grouped,leads,total,firstSent,responded,surveySent,duplicates]=await Promise.all([
    prisma.crmOutreachLead.groupBy({by:['status'],where,_count:true}),
    prisma.crmOutreachLead.findMany({where:{...where,...(status?{status}:{})},orderBy:{createdAt:'desc'},skip:page*50,take:50,include:{comments:{orderBy:{commentedAt:'desc'}},events:{orderBy:{createdAt:'desc'},take:20}}}),
    prisma.crmOutreachLead.count({where}),prisma.crmOutreachLead.count({where:{...where,firstSentAt:{not:null}}}),prisma.crmOutreachLead.count({where:{...where,lastReplyAt:{not:null},firstSentAt:{not:null}}}),prisma.crmOutreachLead.count({where:{...where,surveySentAt:{not:null}}}),prisma.crmOutreachLead.aggregate({where,_sum:{duplicateCount:true}}),
  ]);
  return NextResponse.json({accounts,campaign,leads,counts:Object.fromEntries(grouped.map(g=>[g.status,g._count])),total,firstSent,responded,surveySent,duplicates:duplicates._sum.duplicateCount||0,response_rate:firstSent?responded/firstSent:0,survey_send_rate:firstSent?surveySent/firstSent:0,enabled:enabled()},{headers:{'Cache-Control':'no-store'}});
}
export async function POST(req:NextRequest) {
  const context=await getCurrentWorkspaceContext();if(!context)return NextResponse.json({error:'Unauthorized'},{status:401});
  if(!canManageWorkspace(context.role))return NextResponse.json({error:'Forbidden'},{status:403});
  if(!enabled())return NextResponse.json({error:'CRM_OUTREACH_ENABLED não está ativo'},{status:409});
  const parsed=input.safeParse(await req.json().catch(()=>null));if(!parsed.success)return NextResponse.json({error:'Dados inválidos'},{status:400});
  const body=parsed.data;
  try {
    if(body.action==='import') {if(!body.accountId||!body.mediaIds)throw new Error('Selecione conta e posts');return NextResponse.json(await importComments(context.workspaceId,body.accountId,body.mediaIds));}
    const campaign=await prisma.crmOutreachCampaign.findFirst({where:{id:body.campaignId||'',workspaceId:context.workspaceId}});if(!campaign)throw new Error('Campanha não encontrada');
    if(body.action==='pause')await prisma.crmOutreachCampaign.update({where:{id:campaign.id},data:{status:'paused'}});
    else if(body.action==='resume') {if(body.confirmed!==true)throw new Error('Confirme a retomada');await prisma.crmOutreachCampaign.update({where:{id:campaign.id},data:{status:campaign.pilotReviewedAt?'running':'pilot'}});}
    else if(body.action==='pilot') {
      if(body.confirmed!==true||!body.leadIds||body.leadIds.length>5)throw new Error('Confirme de 1 a 5 leads para o piloto');
      if(campaign.status!=='paused')throw new Error('Pause antes do piloto');
      const leads=await prisma.crmOutreachLead.findMany({where:{id:{in:body.leadIds},campaignId:campaign.id,status:'eligible',firstSentAt:null},include:{comments:true}});
      if(leads.length!==body.leadIds.length||leads.some(l=>!l.comments.some(c=>eligibleComment(c.commentedAt))))throw new Error('Seleção inclui leads inelegíveis');
      await prisma.$transaction(async tx=>{await tx.crmOutreachLead.updateMany({where:{id:{in:body.leadIds},campaignId:campaign.id,status:'eligible'},data:{status:'first_message_queued',isPilot:true,firstQueuedAt:new Date(),nextAttemptAt:new Date()}});await tx.crmOutreachCampaign.update({where:{id:campaign.id},data:{status:'pilot'}});});
      for(const lead of leads)await event(lead.id,'pilot_started',{actor:context.userId});
    } else if(body.action==='start') {
      if(body.confirmed!==true)throw new Error('Revise e confirme o relatório do piloto');
      const sent=await prisma.crmOutreachLead.count({where:{campaignId:campaign.id,isPilot:true,firstSentAt:{not:null}}});
      if(sent<3)throw new Error('Campanha completa exige pelo menos 3 envios piloto confirmados');
      await prisma.$transaction(async tx=>{await tx.crmOutreachCampaign.update({where:{id:campaign.id},data:{status:'running',pilotReviewedAt:new Date()}});await tx.crmOutreachLead.updateMany({where:{campaignId:campaign.id,status:'eligible',firstSentAt:null},data:{status:'first_message_queued',firstQueuedAt:new Date(),nextAttemptAt:new Date()}});});
    } else {
      const lead=await prisma.crmOutreachLead.findFirst({where:{id:body.leadId||'',campaignId:campaign.id},include:{comments:true}});if(!lead)throw new Error('Lead não encontrado');
      if(body.action==='do_not_contact'||body.action==='remove')await prisma.crmOutreachLead.update({where:{id:lead.id},data:{status:'do_not_contact',reason:body.action==='remove'?'removed_by_owner':'owner_opt_out',retrySafe:false}});
      else if(body.action==='approve') {
        if(body.confirmed!==true||lead.status!=='manual_review'||!lead.replyMessageId||!openReplyWindow(lead.lastReplyAt)||lead.sendingPhase)throw new Error('Exige resposta real dentro de 24h e sem envio incerto');
        await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:'manual_review',sendingPhase:null},data:{status:'interested',reason:'manually_approved',nextAttemptAt:new Date()}});
      } else if(body.action==='retry') {
        if(lead.status!=='failed'||!lead.retrySafe||lead.sendStartedAt)throw new Error('Falha não permite repetição segura');
        if(lead.firstSentAt?!openReplyWindow(lead.lastReplyAt):!lead.comments.some(c=>eligibleComment(c.commentedAt)))throw new Error('Janela expirada');
        await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:'failed',retrySafe:true,sendStartedAt:null},data:{status:lead.firstSentAt?'interested':'first_message_queued',nextAttemptAt:new Date(Date.now()+30*60000),reason:'manual_retry_scheduled'}});
      } else if(body.action==='survey_completed') {
        if(body.confirmed!==true||lead.status!=='survey_sent')throw new Error('Confirme a conclusão após verificar a resposta no site');
        await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:'survey_sent'},data:{status:'survey_completed',surveyCompletedAt:new Date(),reason:'admin_verified_completion'}});
      }
      await event(lead.id,'manual_'+body.action,{actor:context.userId});
    }
    return NextResponse.json({ok:true});
  } catch(error) {return NextResponse.json({error:error instanceof Error?error.message:'Falha na operação'},{status:400});}
}

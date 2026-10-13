// Run inside the existing authorized container. No login/session fabrication.
// Import never sends. Pilot requires explicit IDs and --confirm-real-messages.
// This tool cannot release the complete campaign.
import { prisma } from '../lib/db/client';
import { decryptToken } from '../lib/meta/oauth';
import { getAllUserMedia } from '../lib/meta/client';
import { importComments,event } from '../lib/crm-outreach/service';
import { eligibleComment } from '../lib/crm-outreach/rules';
async function main() {
  const [command,username,...links]=process.argv.slice(2);
  if(!['import','report','pilot'].includes(command)||!username)throw new Error('Usage: tsx scripts/crm-outreach-admin.ts import USERNAME URL... | report USERNAME | pilot USERNAME LEAD_ID... --confirm-real-messages');
  const account=await prisma.instagramAccount.findFirst({where:{username}});if(!account)throw new Error('Account not found');
  if(command==='import') {
    if(!links.length)throw new Error('Explicit post selection required');
    const codes=links.map(link=>{const url=new URL(link);if(!['www.instagram.com','instagram.com'].includes(url.hostname))throw new Error('Instagram URL required');const code=url.pathname.match(/^\/(?:reel|p)\/([\w-]+)\/?$/)?.[1];if(!code)throw new Error('Post/reel URL required');return code;});
    const posts=await getAllUserMedia(decryptToken(account.accessToken),500);
    const selected=codes.map(code=>posts.find(p=>p.permalink&&new URL(p.permalink).pathname.split('/').includes(code))?.id);
    if(selected.some(id=>!id))throw new Error('Selected post is not in this account media library');
    console.log(JSON.stringify(await importComments(account.workspaceId,account.id,[...new Set(selected as string[])])));
  }
  const campaign=await prisma.crmOutreachCampaign.findFirst({where:{workspaceId:account.workspaceId,instagramAccountId:account.id,name:'pesquisa_semente_crm'}});if(!campaign)throw new Error('Campaign not imported');
  if(command==='pilot') {
    const ids=[...new Set(links.filter(id=>id!=='--confirm-real-messages'))];
    if(!links.includes('--confirm-real-messages')||ids.length<1||ids.length>5)throw new Error('Explicit confirmation and 1–5 lead IDs required');
    if(campaign.status!=='paused')throw new Error('Pause campaign before selecting a pilot');
    const candidates=await prisma.crmOutreachLead.findMany({where:{id:{in:ids},campaignId:campaign.id,status:'eligible',firstSentAt:null},include:{comments:true}});
    if(candidates.length!==ids.length||candidates.some(l=>!l.comments.some(c=>eligibleComment(c.commentedAt))))throw new Error('Pilot contains ineligible contacts');
    await prisma.$transaction(async tx=>{await tx.crmOutreachLead.updateMany({where:{id:{in:ids},campaignId:campaign.id,status:'eligible'},data:{status:'first_message_queued',isPilot:true,firstQueuedAt:new Date(),nextAttemptAt:new Date()}});await tx.crmOutreachCampaign.update({where:{id:campaign.id},data:{status:'pilot'}});});
    for(const lead of candidates)await event(lead.id,'pilot_started',{actor:'authorized_cli_operator'});
    console.log(JSON.stringify({pilotQueued:ids.length,completeCampaignReleased:false}));
  }
  const leads=await prisma.crmOutreachLead.findMany({where:{campaignId:campaign.id},include:{comments:{orderBy:{commentedAt:'desc'}},events:{orderBy:{createdAt:'desc'},take:5}}});
  const counts:Record<string,number>={};for(const lead of leads)counts[lead.status]=(counts[lead.status]||0)+1;
  const dates=leads.flatMap(l=>l.comments).sort((a,b)=>a.commentedAt.getTime()-b.commentedAt.getTime());
  const samples=[...new Set([0,.25,.5,.75,1].map(f=>dates[Math.floor((dates.length-1)*f)]).filter(Boolean))].map(c=>({commentId:c.commentId,mediaId:c.mediaId,date:c.commentedAt,ageDays:(Date.now()-c.commentedAt.getTime())/86400000,eligibleByAge:eligibleComment(c.commentedAt)}));
  console.log(JSON.stringify({campaignId:campaign.id,status:(await prisma.crmOutreachCampaign.findUniqueOrThrow({where:{id:campaign.id}})).status,mediaIds:campaign.mediaIds,totalUnique:leads.length,counts,duplicates:leads.reduce((sum,l)=>sum+l.duplicateCount,0),samples,candidates:leads.filter(l=>l.status==='eligible').map(l=>({leadId:l.id,commentId:l.comments[0]?.commentId,date:l.comments[0]?.commentedAt})),sent:leads.filter(l=>l.firstSentAt).length},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'failed');process.exitCode=1;}).finally(()=>prisma.$disconnect());

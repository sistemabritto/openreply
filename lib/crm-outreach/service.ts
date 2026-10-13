import { prisma } from '@/lib/db/client';
import { decryptToken } from '@/lib/meta/oauth';
import { getAllUserMedia, getRecentMediaComments, sendPrivateReply, sendDirectMessage, MetaApiError, RateLimitError, TokenExpiredError } from '@/lib/meta/client';
import { getMetaGraphApiVersion } from '@/lib/env';
import { getDMQueue, getRedisConnection, type ProcessMessageJob } from '@/lib/queue/client';
import { reserveDMSlot } from '@/lib/utils/rate-limiter';
import { reserveWorkspaceDMSend, releaseWorkspaceDMReservation } from '@/lib/billing/usage';
import { FIRST_MESSAGE, classifyReply, eligibleComment, openReplyWindow, interestComment, outreachConfig, surveyMessage } from './rules';
export const CRM_JOB = 'crm-outreach-send';
export function enabled() { return process.env.CRM_OUTREACH_ENABLED === 'true'; }
export async function event(leadId:string,type:string,detail?:Record<string,string|number|boolean|null>) {await prisma.crmOutreachEvent.create({data:{leadId,type,detail}});}
export async function importComments(workspaceId:string,accountId:string,mediaIds:string[]) {
  const account=await prisma.instagramAccount.findFirst({where:{id:accountId,workspaceId}});if(!account)throw new Error('Conta não encontrada');
  const token=decryptToken(account.accessToken);const posts=await getAllUserMedia(token,500);
  if(mediaIds.some(id=>!posts.some(p=>p.id===id)))throw new Error('Selecione apenas posts desta conta');
  const campaign=await prisma.crmOutreachCampaign.upsert({where:{workspaceId_instagramAccountId_name:{workspaceId,instagramAccountId:accountId,name:'pesquisa_semente_crm'}},create:{workspaceId,instagramAccountId:accountId,mediaIds},update:{}});
  if(campaign.status!=='paused')throw new Error('Pause a campanha antes de importar');
  let missingIdentity=0,imported=0;
  for(const mediaId of mediaIds) {
    const comments=await getRecentMediaComments(token,mediaId,0,5000);
    if(comments.length>=5000)throw new Error('Post com mais de 5000 comentários: importação parcial bloqueada');
    for(const comment of comments) {
      if(!interestComment(comment.text)||(comment.from?.id===account.instagramId||comment.from?.username===account.username))continue;
      if(!comment.from?.id||!Number.isFinite(new Date(comment.timestamp).getTime())) {missingIdentity++;continue;}
      await prisma.$transaction(async tx=>{
        const lead=await tx.crmOutreachLead.upsert({where:{campaignId_commenterId:{campaignId:campaign.id,commenterId:comment.from!.id}},create:{campaignId:campaign.id,commenterId:comment.from!.id,username:comment.from!.username},update:{}});
        await tx.crmOutreachComment.upsert({where:{campaignId_commentId:{campaignId:campaign.id,commentId:comment.id}},create:{leadId:lead.id,campaignId:campaign.id,commentId:comment.id,mediaId,commentedAt:new Date(comment.timestamp),text:comment.text},update:{}});
        const all=await tx.crmOutreachComment.findMany({where:{leadId:lead.id},orderBy:{commentedAt:'desc'}});
        const contacted=await tx.dmLog.findFirst({where:{instagramAccountId:account.id,status:'SENT',OR:[{commenterId:lead.commenterId},{commentId:{in:all.map(c=>c.commentId)}}]}});
        await tx.crmOutreachLead.update({where:{id:lead.id},data:{duplicateCount:Math.max(0,all.length-1)}});
        await tx.crmOutreachLead.updateMany({where:{id:lead.id,status:{in:['pending','eligible','ineligible']}},data:{status:contacted?'do_not_contact':eligibleComment(all[0].commentedAt)?'eligible':'ineligible',reason:contacted?'already_contacted':eligibleComment(all[0].commentedAt)?'age_candidate_not_api_confirmed':'older_than_7_days'}});
      });imported++;
    }
  }
  await prisma.crmOutreachCampaign.update({where:{id:campaign.id},data:{mediaIds:[...new Set([...campaign.mediaIds,...mediaIds])]}});
  return {campaignId:campaign.id,imported,missingIdentity};
}
export async function handleReply(job:ProcessMessageJob):Promise<boolean> {
  if(!enabled())return false;
  const account=await prisma.instagramAccount.findUnique({where:{instagramId:job.instagramAccountId}});if(!account)return false;
  const lead=await prisma.crmOutreachLead.findFirst({where:{campaign:{instagramAccountId:account.id},OR:[{commenterId:job.senderId},{messagingUserId:job.senderId}]},include:{campaign:true}});
  if(!lead || (!lead.firstQueuedAt && !lead.firstSentAt && !['owner_opt_out','removed_by_owner','explicit_opt_out'].includes(lead.reason||'')))return false;
  // Never let a legacy keyword automation interpret this campaign's answer.
  if(lead.replyMessageId===job.messageId && lead.reason!=='reply_pending_confirmation')return true;
  const intent=classifyReply(job.messageText);
  if(intent==='not_interested') {
    await prisma.crmOutreachLead.update({where:{id:lead.id},data:{status:'not_interested',reason:'explicit_opt_out',retrySafe:false,...(job.inboundTimestamp && openReplyWindow(new Date(job.inboundTimestamp)) ? {lastReplyAt:new Date(job.inboundTimestamp)} : {}),replyMessageId:job.messageId,replyText:job.messageText}});
    await event(lead.id,'opt_out',{messageId:job.messageId});return true;
  }
  if(lead.status==='first_message_queued' && lead.sendingPhase==='first' && job.inboundTimestamp) {
    const at=new Date(job.inboundTimestamp);
    if(openReplyWindow(at) && lead.sendStartedAt && at>=lead.sendStartedAt) {
      await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:'first_message_queued',sendingPhase:'first'},data:{replyMessageId:job.messageId,replyText:job.messageText,lastReplyAt:at,reason:'reply_pending_confirmation'}});
    }
    return true;
  }
  if(lead.status!=='waiting_reply'||!lead.firstSentAt)return true;
  const at=job.inboundTimestamp?new Date(job.inboundTimestamp):null;
  if(!at||!openReplyWindow(at)||at.getTime()<(lead.sendStartedAt||lead.firstSentAt).getTime()) {
    await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:'waiting_reply'},data:{status:'manual_review',reason:'unverified_or_expired_reply_time'}});return true;
  }
  const changed=await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:'waiting_reply',surveySentAt:null},data:{status:intent,lastReplyAt:at,replyMessageId:job.messageId,replyText:job.messageText,reason:intent==='manual_review'?'ambiguous_reply':null,nextAttemptAt:new Date()}});
  if(changed.count)await event(lead.id,'reply_classified',{classification:intent,messageId:job.messageId});
  return true;
}
export async function ownsComment(accountIgId:string,commenterId:string,mediaIds:string[]) {
  if(!enabled())return false;
  const account=await prisma.instagramAccount.findUnique({where:{instagramId:accountIgId},select:{id:true}});if(!account)return false;
  return !!await prisma.crmOutreachLead.findFirst({where:{commenterId,campaign:{instagramAccountId:account.id,mediaIds:{hasSome:mediaIds}},OR:[{firstQueuedAt:{not:null}},{reason:{in:['owner_opt_out','removed_by_owner','explicit_opt_out']}}]},select:{id:true}});
}
const RATE_SCRIPT=`local b=tonumber(redis.call('GET',KEYS[1]) or '0'); local d=tonumber(redis.call('GET',KEYS[2]) or '0'); if b>=tonumber(ARGV[1]) or d>=tonumber(ARGV[2]) then return 0 end; if redis.call('INCR',KEYS[1])==1 then redis.call('PEXPIRE',KEYS[1],ARGV[3]) end; if redis.call('INCR',KEYS[2])==1 then redis.call('EXPIRE',KEYS[2],172800) end; return 1`;
async function reserveCampaign(campaignId:string) { const c=outreachConfig();return Number(await getRedisConnection().eval(RATE_SCRIPT,2,`crm-batch-${campaignId}`,`crm-day-${campaignId}-${new Date().toISOString().slice(0,10)}`,c.batch,c.daily,c.interval))===1; }
export async function tickOutreach() {
  if(!enabled())return;
  outreachConfig();
  // An interrupted POST is not safe to repeat, even if BullMQ lost its job.
  await prisma.crmOutreachLead.updateMany({where:{sendStartedAt:{lt:new Date(Date.now()-15*60000)},sendingPhase:{not:null},status:{in:['first_message_queued','interested']}},data:{status:'manual_review',reason:'send_outcome_unknown',retrySafe:false}});
  const fastReplies=await prisma.crmOutreachLead.findMany({where:{status:'waiting_reply',reason:'reply_pending_confirmation',replyMessageId:{not:null}},include:{campaign:true},take:50});
  for(const lead of fastReplies) {
    const account=await prisma.instagramAccount.findUnique({where:{id:lead.campaign.instagramAccountId}});
    if(account && lead.replyMessageId && lead.replyText && lead.lastReplyAt)await handleReply({instagramAccountId:account.instagramId,senderId:lead.messagingUserId||lead.commenterId,messageId:lead.replyMessageId,messageText:lead.replyText,inboundTimestamp:lead.lastReplyAt.toISOString()});
  }
  const leads=await prisma.crmOutreachLead.findMany({where:{status:{in:['first_message_queued','interested']},sendingPhase:null,nextAttemptAt:{lte:new Date()},campaign:{status:{in:['running','pilot']}}},include:{campaign:true},take:50});
  for(const lead of leads) {
    if(lead.campaign.status==='pilot'&&!lead.isPilot)continue;
    await getDMQueue().add(CRM_JOB,{leadId:lead.id,phase:lead.status==='interested'?'survey':'first'},{jobId:`crm_${lead.id}_${lead.status}`,attempts:1,removeOnComplete:true,removeOnFail:true});
  }
}
export async function sendOutreach(leadId:string,phase:'first'|'survey') {
  if(!enabled())return;
  const lead=await prisma.crmOutreachLead.findUnique({where:{id:leadId},include:{campaign:true,comments:{orderBy:{commentedAt:'desc'}}}});if(!lead)return;
  if(lead.surveySentAt||lead.surveyMessageId||lead.surveyCompletedAt)return;
  const expected=phase==='first'?'first_message_queued':'interested';
  if(lead.status!==expected||lead.sendingPhase||lead.nextAttemptAt>new Date()||!['running','pilot'].includes(lead.campaign.status)||(lead.campaign.status==='pilot'&&!lead.isPilot))return;
  const account=await prisma.instagramAccount.findUnique({where:{id:lead.campaign.instagramAccountId}});if(!account)return;
  let usage:Awaited<ReturnType<typeof reserveWorkspaceDMSend>>|undefined;
  let posted=false;
  try {
    const token=decryptToken(account.accessToken);
    const comment=lead.comments.find(c=>eligibleComment(c.commentedAt)&&lead.campaign.mediaIds.includes(c.mediaId));
    if(phase==='first') {
      if(lead.firstSentAt||!comment) {await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:expected},data:{status:'ineligible',reason:'private_reply_window_expired'}});return;}
      const prior=await prisma.dmLog.findFirst({where:{instagramAccountId:account.id,status:'SENT',OR:[{commenterId:lead.commenterId},{commentId:{in:lead.comments.map(c=>c.commentId)}}]}});
      if(prior) {await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:expected},data:{status:'do_not_contact',reason:'already_contacted'}});return;}
      const response=await fetch(`https://graph.instagram.com/${getMetaGraphApiVersion()}/${comment.commentId}?fields=id,timestamp,from`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
      const data=await response.json();
      await event(lead.id,'private_reply_preflight',{commentId:comment.commentId,ageDays:(Date.now()-comment.commentedAt.getTime())/86400000,http:response.status});
      if(!response.ok)throw new MetaApiError(data.error?.code||100,data.error?.error_subcode,data.error?.fbtrace_id,data.error?.message || 'comment_preflight_rejected');
      if(data.from?.id!==lead.commenterId||!eligibleComment(new Date(data.timestamp))) {await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:expected},data:{status:'ineligible',reason:'comment_identity_or_age_invalid'}});return;}
    } else if(!lead.firstSentAt||!lead.replyMessageId||!lead.messagingUserId||!openReplyWindow(lead.lastReplyAt)) {
      await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:expected},data:{status:'manual_review',reason:'messaging_window_expired',retrySafe:false}});return;
    }
    if(!await reserveCampaign(lead.campaignId)) {await prisma.crmOutreachLead.update({where:{id:lead.id},data:{nextAttemptAt:new Date(Date.now()+outreachConfig().interval)}});return;}
    const slot=await reserveDMSlot(account.instagramId);if(!slot.allowed) {await prisma.crmOutreachLead.update({where:{id:lead.id},data:{nextAttemptAt:new Date(Date.now()+Math.max(slot.requeueDelayMs,30*60000))}});return;}
    usage=await reserveWorkspaceDMSend(account.workspaceId);if(!usage.allowed)throw new Error('workspace_plan_limit');
    const claimed=await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:expected,sendingPhase:null},data:{sendingPhase:phase,sendStartedAt:new Date(),retrySafe:false}});if(!claimed.count) {await releaseWorkspaceDMReservation(account.workspaceId,usage.periodStart);return;}
    // Recheck pause/opt-out immediately before the single official POST.
    const current=await prisma.crmOutreachLead.findUnique({where:{id:lead.id},include:{campaign:true}});
    if(!current||current.status!==expected||!['running','pilot'].includes(current.campaign.status)) {await prisma.crmOutreachLead.updateMany({where:{id:lead.id,sendingPhase:phase},data:{sendingPhase:null,sendStartedAt:null}});await releaseWorkspaceDMReservation(account.workspaceId,usage.periodStart);return;}
    if(phase==='first' ? !eligibleComment(comment!.commentedAt) : !openReplyWindow(current.lastReplyAt)) {
      await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:expected,sendingPhase:phase},data:{status:phase==='first'?'ineligible':'manual_review',reason:'window_expired_before_post',sendingPhase:null,sendStartedAt:null,retrySafe:false}});
      await releaseWorkspaceDMReservation(account.workspaceId,usage.periodStart);return;
    }
    posted=true;
    const result=phase==='first'?await sendPrivateReply(token,account.instagramId,comment!.commentId,FIRST_MESSAGE):await sendDirectMessage(token,account.instagramId,lead.messagingUserId!,surveyMessage());
    if(!result.message_id)throw new Error('send_outcome_unknown');
    // Persist the real receipt even when an opt-out arrived during the POST.
    // Only the conditional status transition may create waiting_reply/survey_sent.
    await prisma.$transaction(async tx=>{
      await tx.crmOutreachLead.updateMany({where:{id:lead.id,status:expected,sendingPhase:phase},data:{status:phase==='first'?'waiting_reply':'survey_sent'}});
      await tx.crmOutreachLead.update({where:{id:lead.id},data:phase==='first'?{firstSentAt:new Date(),firstMessageId:result.message_id,messagingUserId:result.recipient_id,sendingPhase:null}:{surveySentAt:new Date(),surveyMessageId:result.message_id,sendingPhase:null}});
      await tx.crmOutreachLead.updateMany({where:{id:lead.id,status:'waiting_reply',reason:'age_candidate_not_api_confirmed'},data:{reason:null}});
    });
    await event(lead.id,phase==='first'?'first_message_sent':'survey_sent',{messageId:result.message_id,recipientId:result.recipient_id,http:200,commentId:phase==='first'?comment!.commentId:null,ageDays:phase==='first'?(Date.now()-comment!.commentedAt.getTime())/86400000:null});
  } catch(error) {
    const known=error instanceof MetaApiError;
    const uncertain=posted&&!known;
    const reason=uncertain?'send_outcome_unknown':known?`Meta ${error.code}/${error.subcode||0}: ${error.message}`:error instanceof Error?error.message:'failed';
    if(usage?.allowed&&!uncertain)await releaseWorkspaceDMReservation(account.workspaceId,usage.periodStart);
    await prisma.crmOutreachLead.updateMany({where:{id:lead.id,status:expected},data:{status:uncertain?'manual_review':'failed',reason,retrySafe:!posted||error instanceof RateLimitError,sendingPhase:uncertain?phase:null,sendStartedAt:uncertain?new Date():null}});
    await event(lead.id,'send_failed',{phase,reason,knownMetaRejection:known,uncertain});
    // Official refusals stop the campaign. A retry needs a manual action.
    if(known||error instanceof TokenExpiredError)await prisma.crmOutreachCampaign.update({where:{id:lead.campaignId},data:{status:'paused'}});
  }
}

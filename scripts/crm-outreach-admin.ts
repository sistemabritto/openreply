// Run inside the existing authorized container. No login/session fabrication.
// This tool imports only; it cannot start a campaign or send a DM.
import { prisma } from '../lib/db/client';
import { decryptToken } from '../lib/meta/oauth';
import { getAllUserMedia } from '../lib/meta/client';
import { importComments } from '../lib/crm-outreach/service';
import { eligibleComment } from '../lib/crm-outreach/rules';
async function main() {
  const [command,username,...links]=process.argv.slice(2);
  if(!['import','report'].includes(command)||!username)throw new Error('Usage: tsx scripts/crm-outreach-admin.ts import USERNAME URL... | report USERNAME');
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
  const leads=await prisma.crmOutreachLead.findMany({where:{campaignId:campaign.id},include:{comments:{orderBy:{commentedAt:'desc'}},events:{orderBy:{createdAt:'desc'},take:5}}});
  const counts:Record<string,number>={};for(const lead of leads)counts[lead.status]=(counts[lead.status]||0)+1;
  const dates=leads.flatMap(l=>l.comments).sort((a,b)=>a.commentedAt.getTime()-b.commentedAt.getTime());
  const samples=[...new Set([0,.25,.5,.75,1].map(f=>dates[Math.floor((dates.length-1)*f)]).filter(Boolean))].map(c=>({commentId:c.commentId,mediaId:c.mediaId,date:c.commentedAt,ageDays:(Date.now()-c.commentedAt.getTime())/86400000,eligibleByAge:eligibleComment(c.commentedAt)}));
  console.log(JSON.stringify({campaignId:campaign.id,status:campaign.status,mediaIds:campaign.mediaIds,totalUnique:leads.length,counts,duplicates:leads.reduce((sum,l)=>sum+l.duplicateCount,0),samples,candidates:leads.filter(l=>l.status==='eligible').map(l=>({leadId:l.id,commentId:l.comments[0]?.commentId,date:l.comments[0]?.commentedAt})),sent:leads.filter(l=>l.firstSentAt).length},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'failed');process.exitCode=1;}).finally(()=>prisma.$disconnect());

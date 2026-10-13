BEGIN;
-- CreateTable
CREATE TABLE "CrmOutreachCampaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'pesquisa_semente_crm',
    "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'paused',
    "pilotReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmOutreachCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmOutreachLead" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "commenterId" TEXT NOT NULL,
    "username" TEXT,
    "messagingUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "firstQueuedAt" TIMESTAMP(3),
    "firstSentAt" TIMESTAMP(3),
    "firstMessageId" TEXT,
    "lastReplyAt" TIMESTAMP(3),
    "replyMessageId" TEXT,
    "replyText" TEXT,
    "surveySentAt" TIMESTAMP(3),
    "surveyMessageId" TEXT,
    "surveyCompletedAt" TIMESTAMP(3),
    "sendingPhase" TEXT,
    "sendStartedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retrySafe" BOOLEAN NOT NULL DEFAULT false,
    "isPilot" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmOutreachLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmOutreachComment" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "commentedAt" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "CrmOutreachComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmOutreachEvent" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmOutreachEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmOutreachCampaign_workspaceId_idx" ON "CrmOutreachCampaign"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmOutreachCampaign_workspaceId_instagramAccountId_name_key" ON "CrmOutreachCampaign"("workspaceId", "instagramAccountId", "name");

-- CreateIndex
CREATE INDEX "CrmOutreachLead_status_nextAttemptAt_idx" ON "CrmOutreachLead"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmOutreachLead_campaignId_commenterId_key" ON "CrmOutreachLead"("campaignId", "commenterId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmOutreachLead_campaignId_messagingUserId_key" ON "CrmOutreachLead"("campaignId", "messagingUserId");

-- CreateIndex
CREATE INDEX "CrmOutreachComment_leadId_commentedAt_idx" ON "CrmOutreachComment"("leadId", "commentedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmOutreachComment_campaignId_commentId_key" ON "CrmOutreachComment"("campaignId", "commentId");

-- CreateIndex
CREATE INDEX "CrmOutreachEvent_leadId_createdAt_idx" ON "CrmOutreachEvent"("leadId", "createdAt");

-- AddForeignKey
ALTER TABLE "CrmOutreachCampaign" ADD CONSTRAINT "CrmOutreachCampaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmOutreachCampaign" ADD CONSTRAINT "CrmOutreachCampaign_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmOutreachLead" ADD CONSTRAINT "CrmOutreachLead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CrmOutreachCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmOutreachComment" ADD CONSTRAINT "CrmOutreachComment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CrmOutreachLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmOutreachEvent" ADD CONSTRAINT "CrmOutreachEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CrmOutreachLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;

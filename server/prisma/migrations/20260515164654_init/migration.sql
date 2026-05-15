-- CreateTable
CREATE TABLE "chunks" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "chunkType" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "repo" TEXT NOT NULL,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conventions" (
    "id" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sourcePr" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conventions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "issues" JSONB,
    "summary" TEXT,
    "prOutcome" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chunks_repo_idx" ON "chunks"("repo");

-- CreateIndex
CREATE INDEX "conventions_repo_idx" ON "conventions"("repo");

-- CreateIndex
CREATE INDEX "reviews_repo_prNumber_idx" ON "reviews"("repo", "prNumber");

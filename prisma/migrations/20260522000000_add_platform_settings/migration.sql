-- CreateTable
CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "serviceFeePercent" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "loyaltyPointsPer100Xaf" INTEGER NOT NULL DEFAULT 1,
    "loyaltyPointValueXaf" INTEGER NOT NULL DEFAULT 5,
    "loyaltyMinRedemption" INTEGER NOT NULL DEFAULT 100,
    "referrerBonusPoints" INTEGER NOT NULL DEFAULT 500,
    "referredBonusPoints" INTEGER NOT NULL DEFAULT 200,
    "maintenanceMode" BOOLEAN NOT NULL DEFAULT false,
    "maintenanceMessage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

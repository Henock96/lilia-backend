import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdatePlatformSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  serviceFeePercent?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  loyaltyPointsPer100Xaf?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  loyaltyPointValueXaf?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  loyaltyMinRedemption?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  referrerBonusPoints?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  referredBonusPoints?: number;

  @IsOptional()
  @IsBoolean()
  maintenanceMode?: boolean;

  @IsOptional()
  @IsString()
  maintenanceMessage?: string;
}

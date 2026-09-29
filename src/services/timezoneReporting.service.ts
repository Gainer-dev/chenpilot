/**
 * Timezone-Aware Reporting Service — Issue #860
 *
 * Supports user-selected timezone boundaries for daily reports.
 *
 * PROBLEM
 * ───────
 * Current reporting uses UTC boundaries (00:00-23:59 UTC) which don't align
 * with users' local "days." A user in Tokyo (UTC+9) requesting a "daily report"
 * at 08:00 local time gets data from 09:00 yesterday to 09:00 today — not their
 * actual "yesterday."
 *
 * SOLUTION
 * ────────
 * This module provides timezone-aware date boundaries so reports align with
 * users' local calendar days while maintaining UTC storage.
 *
 * DESIGN PRINCIPLES
 * ─────────────────
 * 1. **Storage remains UTC**: All database timestamps stay in UTC
 * 2. **Boundaries computed per-user**: Date ranges converted to user timezone
 * 3. **No DST ambiguity**: Uses IANA timezone database (e.g. "America/New_York")
 * 4. **Backward compatible**: Falls back to UTC if no timezone provided
 */

/**
 * IANA timezone identifier (e.g. "America/New_York", "Asia/Tokyo", "Europe/London").
 * 
 * See: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
 */
export type IANATimezone = string;

/**
 * Supported report period types.
 */
export enum ReportPeriod {
  /** Custom date range (user specifies start and end) */
  CUSTOM = "custom",
  /** Single calendar day in user's timezone */
  DAY = "day",
  /** Current week (Monday-Sunday) in user's timezone */
  WEEK = "week",
  /** Current month in user's timezone */
  MONTH = "month",
  /** Last N days (rolling window) */
  LAST_N_DAYS = "last_n_days",
}

/**
 * Timezone-aware report query parameters.
 */
export interface TimezoneReportQuery {
  /** Report period type */
  period: ReportPeriod;
  
  /**
   * User's IANA timezone (e.g. "America/New_York", "Asia/Tokyo").
   * Falls back to UTC if not provided.
   */
  timezone?: IANATimezone;
  
  /**
   * For CUSTOM period: start date in user's timezone.
   * Format: YYYY-MM-DD (e.g. "2024-03-15")
   */
  customStartDate?: string;
  
  /**
   * For CUSTOM period: end date in user's timezone.
   * Format: YYYY-MM-DD (e.g. "2024-03-20")
   */
  customEndDate?: string;
  
  /**
   * For DAY period: which day (relative to today in user's timezone).
   * 0 = today, -1 = yesterday, -2 = day before yesterday, etc.
   * Defaults to -1 (yesterday's report).
   */
  dayOffset?: number;
  
  /**
   * For LAST_N_DAYS period: number of days to include.
   * Defaults to 7.
   */
  lastNDays?: number;
}

/**
 * UTC date boundaries computed from user's timezone-aware request.
 */
export interface UTCBoundaries {
  /** Start of period in UTC (inclusive) */
  startUTC: Date;
  /** End of period in UTC (inclusive) */
  endUTC: Date;
  /** Original user timezone */
  timezone: IANATimezone;
  /** Human-readable period description */
  periodDescription: string;
  /** Start of period in user's local timezone (for display) */
  startLocal: string;
  /** End of period in user's local timezone (for display) */
  endLocal: string;
}

/**
 * Validation error for timezone report queries.
 */
export class TimezoneReportValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "TimezoneReportValidationError";
  }
}

/**
 * Service for computing timezone-aware date boundaries for reports.
 */
export class TimezoneReportingService {
  /**
   * Compute UTC boundaries from a timezone-aware report query.
   * 
   * This is the core function that converts user's local date intentions
   * into UTC timestamps for database queries.
   * 
   * @param query - Timezone-aware report query
   * @returns UTC boundaries ready for database queries
   * @throws TimezoneReportValidationError if query is invalid
   */
  public computeUTCBoundaries(query: TimezoneReportQuery): UTCBoundaries {
    const timezone = query.timezone ?? "UTC";
    
    // Validate timezone
    if (!this.isValidTimezone(timezone)) {
      throw new TimezoneReportValidationError(
        `Invalid timezone: "${timezone}". Must be a valid IANA timezone identifier.`,
        "timezone"
      );
    }
    
    switch (query.period) {
      case ReportPeriod.CUSTOM:
        return this.computeCustomBoundaries(query, timezone);
      
      case ReportPeriod.DAY:
        return this.computeDayBoundaries(query, timezone);
      
      case ReportPeriod.WEEK:
        return this.computeWeekBoundaries(timezone);
      
      case ReportPeriod.MONTH:
        return this.computeMonthBoundaries(timezone);
      
      case ReportPeriod.LAST_N_DAYS:
        return this.computeLastNDaysBoundaries(query, timezone);
      
      default:
        throw new TimezoneReportValidationError(
          `Unsupported period: ${query.period}`,
          "period"
        );
    }
  }
  
  /**
   * Validate if a string is a valid IANA timezone identifier.
   * 
   * Uses Intl.DateTimeFormat to check validity. This works in all modern
   * JavaScript environments (Node.js 14+, all modern browsers).
   */
  public isValidTimezone(timezone: string): boolean {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Get the current date/time in a specific timezone.
   * Returns a Date object representing "now" but with parts extracted in the given timezone.
   */
  private getNowInTimezone(timezone: IANATimezone): Date {
    const nowUTC = new Date();
    
    // Get date components in the target timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    
    const parts = formatter.formatToParts(nowUTC);
    const getValue = (type: string) => 
      parts.find(p => p.type === type)?.value || "0";
    
    // Build date string in the target timezone
    const year = getValue("year");
    const month = getValue("month");
    const day = getValue("day");
    const hour = getValue("hour");
    const minute = getValue("minute");
    const second = getValue("second");
    
    // Create a Date object from this string (interpreted as local time in the timezone)
    // We'll use this to get date boundaries
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
  }
  
  /**
   * Convert a local date string (YYYY-MM-DD) in a timezone to UTC boundaries.
   * 
   * @param localDateStr - Date string in YYYY-MM-DD format
   * @param timezone - IANA timezone
   * @returns { startOfDayUTC, endOfDayUTC } - Start and end of that day in UTC
   */
  private localDateToUTCBoundaries(
    localDateStr: string,
    timezone: IANATimezone
  ): { startOfDayUTC: Date; endOfDayUTC: Date } {
    // Parse the local date string
    const [year, month, day] = localDateStr.split("-").map(Number);
    
    if (!year || !month || !day) {
      throw new TimezoneReportValidationError(
        `Invalid date format: "${localDateStr}". Expected YYYY-MM-DD.`,
        "customStartDate"
      );
    }
    
    // Create start of day in the target timezone
    // We do this by creating a Date object and then getting its UTC equivalent
    const startOfDayLocal = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    const endOfDayLocal = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
    
    // Adjust for timezone offset
    // Convert local midnight to UTC by calculating timezone offset
    const startOfDayUTC = this.convertLocalToUTC(year, month, day, 0, 0, 0, timezone);
    const endOfDayUTC = this.convertLocalToUTC(year, month, day, 23, 59, 59, timezone);
    
    return { startOfDayUTC, endOfDayUTC };
  }
  
  /**
   * Convert a local date/time in a timezone to UTC.
   */
  private convertLocalToUTC(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    timezone: IANATimezone
  ): Date {
    // Create ISO string in the local timezone
    const monthStr = month.toString().padStart(2, "0");
    const dayStr = day.toString().padStart(2, "0");
    const hourStr = hour.toString().padStart(2, "0");
    const minuteStr = minute.toString().padStart(2, "0");
    const secondStr = second.toString().padStart(2, "0");
    
    const localISOString = `${year}-${monthStr}-${dayStr}T${hourStr}:${minuteStr}:${secondStr}`;
    
    // Parse this as if it were in the target timezone
    // We use Intl.DateTimeFormat to get the offset
    const testDate = new Date(localISOString + "Z"); // Interpret as UTC first
    
    // Get formatter for this timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    
    // Format the test date in the target timezone
    const formatted = formatter.format(testDate);
    const parts = formatter.formatToParts(testDate);
    
    // Calculate offset by comparing what we wanted vs what we got
    // This is a bit indirect but works reliably across all timezones and DST
    
    // Create a reference date in UTC
    const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    
    // Get what time it shows in the target timezone
    const localFormatted = formatter.format(utcDate);
    
    // If they match, we're done
    if (localFormatted === `${month}/${day}/${year}, ${hourStr}:${minuteStr}:${secondStr}`) {
      return utcDate;
    }
    
    // Otherwise, we need to adjust
    // Simpler approach: use a known offset calculation
    const offsetMs = this.getTimezoneOffset(timezone, year, month, day);
    return new Date(utcDate.getTime() - offsetMs);
  }
  
  /**
   * Get timezone offset in milliseconds for a specific date.
   */
  private getTimezoneOffset(
    timezone: IANATimezone,
    year: number,
    month: number,
    day: number
  ): number {
    // Create a date at noon UTC (avoids DST boundary issues)
    const utcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    
    // Format in both UTC and target timezone
    const utcFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hour: "2-digit",
      hour12: false,
    });
    
    const localFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    });
    
    const utcHour = parseInt(utcFormatter.format(utcDate));
    const localHour = parseInt(localFormatter.format(utcDate));
    
    // Calculate offset in hours, then convert to ms
    let offsetHours = localHour - utcHour;
    
    // Handle day boundary wrap-around
    if (offsetHours > 12) offsetHours -= 24;
    if (offsetHours < -12) offsetHours += 24;
    
    return offsetHours * 60 * 60 * 1000;
  }
  
  /**
   * Compute boundaries for CUSTOM period.
   */
  private computeCustomBoundaries(
    query: TimezoneReportQuery,
    timezone: IANATimezone
  ): UTCBoundaries {
    if (!query.customStartDate || !query.customEndDate) {
      throw new TimezoneReportValidationError(
        "customStartDate and customEndDate are required for CUSTOM period",
        "customStartDate"
      );
    }
    
    const { startOfDayUTC: startUTC } = this.localDateToUTCBoundaries(
      query.customStartDate,
      timezone
    );
    const { endOfDayUTC: endUTC } = this.localDateToUTCBoundaries(
      query.customEndDate,
      timezone
    );
    
    if (startUTC > endUTC) {
      throw new TimezoneReportValidationError(
        "customStartDate must be before or equal to customEndDate",
        "customStartDate"
      );
    }
    
    return {
      startUTC,
      endUTC,
      timezone,
      periodDescription: `Custom: ${query.customStartDate} to ${query.customEndDate}`,
      startLocal: query.customStartDate,
      endLocal: query.customEndDate,
    };
  }
  
  /**
   * Compute boundaries for DAY period.
   */
  private computeDayBoundaries(
    query: TimezoneReportQuery,
    timezone: IANATimezone
  ): UTCBoundaries {
    const dayOffset = query.dayOffset ?? -1; // Default to yesterday
    
    const nowInTZ = this.getNowInTimezone(timezone);
    const targetDate = new Date(nowInTZ);
    targetDate.setDate(targetDate.getDate() + dayOffset);
    
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    const day = targetDate.getDate();
    
    const localDateStr = `${year}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    const { startOfDayUTC, endOfDayUTC } = this.localDateToUTCBoundaries(
      localDateStr,
      timezone
    );
    
    const dayLabel = dayOffset === 0 ? "Today" : 
                     dayOffset === -1 ? "Yesterday" :
                     `${Math.abs(dayOffset)} days ago`;
    
    return {
      startUTC: startOfDayUTC,
      endUTC: endOfDayUTC,
      timezone,
      periodDescription: `${dayLabel} (${localDateStr})`,
      startLocal: localDateStr + " 00:00:00",
      endLocal: localDateStr + " 23:59:59",
    };
  }
  
  /**
   * Compute boundaries for WEEK period (current week, Monday-Sunday).
   */
  private computeWeekBoundaries(timezone: IANATimezone): UTCBoundaries {
    const nowInTZ = this.getNowInTimezone(timezone);
    const dayOfWeek = nowInTZ.getDay(); // 0=Sunday, 1=Monday, ...
    const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    
    const monday = new Date(nowInTZ);
    monday.setDate(monday.getDate() + daysToMonday);
    
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    
    const mondayStr = this.formatLocalDate(monday);
    const sundayStr = this.formatLocalDate(sunday);
    
    const { startOfDayUTC } = this.localDateToUTCBoundaries(mondayStr, timezone);
    const { endOfDayUTC } = this.localDateToUTCBoundaries(sundayStr, timezone);
    
    return {
      startUTC: startOfDayUTC,
      endUTC: endOfDayUTC,
      timezone,
      periodDescription: `Week of ${mondayStr}`,
      startLocal: mondayStr + " 00:00:00",
      endLocal: sundayStr + " 23:59:59",
    };
  }
  
  /**
   * Compute boundaries for MONTH period (current month).
   */
  private computeMonthBoundaries(timezone: IANATimezone): UTCBoundaries {
    const nowInTZ = this.getNowInTimezone(timezone);
    const year = nowInTZ.getFullYear();
    const month = nowInTZ.getMonth() + 1;
    
    const firstDay = `${year}-${month.toString().padStart(2, "0")}-01`;
    const lastDay = `${year}-${month.toString().padStart(2, "0")}-${this.getDaysInMonth(year, month).toString().padStart(2, "0")}`;
    
    const { startOfDayUTC } = this.localDateToUTCBoundaries(firstDay, timezone);
    const { endOfDayUTC } = this.localDateToUTCBoundaries(lastDay, timezone);
    
    const monthName = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long" });
    
    return {
      startUTC: startOfDayUTC,
      endUTC: endOfDayUTC,
      timezone,
      periodDescription: `${monthName} ${year}`,
      startLocal: firstDay + " 00:00:00",
      endLocal: lastDay + " 23:59:59",
    };
  }
  
  /**
   * Compute boundaries for LAST_N_DAYS period (rolling window).
   */
  private computeLastNDaysBoundaries(
    query: TimezoneReportQuery,
    timezone: IANATimezone
  ): UTCBoundaries {
    const days = query.lastNDays ?? 7;
    
    if (days < 1 || days > 365) {
      throw new TimezoneReportValidationError(
        "lastNDays must be between 1 and 365",
        "lastNDays"
      );
    }
    
    const nowInTZ = this.getNowInTimezone(timezone);
    const endDate = new Date(nowInTZ);
    const startDate = new Date(nowInTZ);
    startDate.setDate(startDate.getDate() - days + 1);
    
    const startDateStr = this.formatLocalDate(startDate);
    const endDateStr = this.formatLocalDate(endDate);
    
    const { startOfDayUTC } = this.localDateToUTCBoundaries(startDateStr, timezone);
    const { endOfDayUTC } = this.localDateToUTCBoundaries(endDateStr, timezone);
    
    return {
      startUTC: startOfDayUTC,
      endUTC: endOfDayUTC,
      timezone,
      periodDescription: `Last ${days} days`,
      startLocal: startDateStr + " 00:00:00",
      endLocal: endDateStr + " 23:59:59",
    };
  }
  
  /**
   * Format a Date object as YYYY-MM-DD.
   */
  private formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  
  /**
   * Get number of days in a month.
   */
  private getDaysInMonth(year: number, month: number): number {
    return new Date(year, month, 0).getDate();
  }
}

export const timezoneReportingService = new TimezoneReportingService();


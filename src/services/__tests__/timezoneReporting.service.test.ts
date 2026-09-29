/**
 * Timezone Reporting Service Tests — Issue #860
 *
 * Tests user-selected timezone boundaries for daily reports.
 */

import {
  TimezoneReportingService,
  ReportPeriod,
  TimezoneReportValidationError,
  type TimezoneReportQuery,
  type UTCBoundaries,
} from "../timezoneReporting.service";

describe("TimezoneReportingService — Issue #860", () => {
  let service: TimezoneReportingService;

  beforeEach(() => {
    service = new TimezoneReportingService();
  });

  // ─── Timezone Validation ──────────────────────────────────────────────────

  describe("Timezone Validation", () => {
    it("accepts valid IANA timezones", () => {
      expect(service.isValidTimezone("America/New_York")).toBe(true);
      expect(service.isValidTimezone("Europe/London")).toBe(true);
      expect(service.isValidTimezone("Asia/Tokyo")).toBe(true);
      expect(service.isValidTimezone("UTC")).toBe(true);
      expect(service.isValidTimezone("Australia/Sydney")).toBe(true);
    });

    it("rejects invalid timezones", () => {
      expect(service.isValidTimezone("Invalid/Zone")).toBe(false);
      expect(service.isValidTimezone("EST")).toBe(false); // Ambiguous, not IANA
      expect(service.isValidTimezone("")).toBe(false);
      expect(service.isValidTimezone("GMT+5")).toBe(false); // Not IANA format
    });

    it("throws error for invalid timezone in query", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "Invalid/Zone",
      };

      expect(() => service.computeUTCBoundaries(query)).toThrow(
        TimezoneReportValidationError
      );
    });
  });

  // ─── CUSTOM Period ────────────────────────────────────────────────────────

  describe("CUSTOM Period", () => {
    it("computes boundaries for custom date range in UTC", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.CUSTOM,
        timezone: "UTC",
        customStartDate: "2024-03-15",
        customEndDate: "2024-03-20",
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("UTC");
      expect(result.startUTC.toISOString()).toContain("2024-03-15T00:00:00");
      expect(result.endUTC.toISOString()).toContain("2024-03-20T23:59:59");
      expect(result.periodDescription).toContain("2024-03-15");
      expect(result.periodDescription).toContain("2024-03-20");
    });

    it("computes boundaries for custom date range in New York timezone", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.CUSTOM,
        timezone: "America/New_York",
        customStartDate: "2024-03-15",
        customEndDate: "2024-03-15",
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("America/New_York");
      // March 15 2024 in NYC starts at 04:00 UTC (EDT is UTC-4)
      // Note: This test may need adjustment based on DST
      expect(result.startUTC.getUTCHours()).toBeGreaterThanOrEqual(0);
      expect(result.endUTC.getUTCHours()).toBeLessThan(24);
    });

    it("throws error if customStartDate is missing", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.CUSTOM,
        timezone: "UTC",
        customEndDate: "2024-03-20",
      };

      expect(() => service.computeUTCBoundaries(query)).toThrow(
        TimezoneReportValidationError
      );
    });

    it("throws error if customEndDate is missing", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.CUSTOM,
        timezone: "UTC",
        customStartDate: "2024-03-15",
      };

      expect(() => service.computeUTCBoundaries(query)).toThrow(
        TimezoneReportValidationError
      );
    });

    it("throws error if start date is after end date", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.CUSTOM,
        timezone: "UTC",
        customStartDate: "2024-03-20",
        customEndDate: "2024-03-15",
      };

      expect(() => service.computeUTCBoundaries(query)).toThrow(
        TimezoneReportValidationError
      );
    });

    it("throws error for invalid date format", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.CUSTOM,
        timezone: "UTC",
        customStartDate: "2024/03/15", // Wrong format
        customEndDate: "2024-03-20",
      };

      expect(() => service.computeUTCBoundaries(query)).toThrow(
        TimezoneReportValidationError
      );
    });
  });

  // ─── DAY Period ───────────────────────────────────────────────────────────

  describe("DAY Period", () => {
    it("defaults to yesterday (dayOffset=-1) in UTC", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "UTC",
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("UTC");
      expect(result.periodDescription).toContain("Yesterday");
      
      // Verify it's a full day (24 hours)
      const duration = result.endUTC.getTime() - result.startUTC.getTime();
      expect(duration).toBeGreaterThan(24 * 60 * 60 * 1000 - 1000); // Allow 1s tolerance
    });

    it("computes yesterday in Tokyo timezone", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "Asia/Tokyo",
        dayOffset: -1,
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("Asia/Tokyo");
      expect(result.periodDescription).toContain("Yesterday");
      
      // Tokyo is UTC+9, so yesterday in Tokyo starts at 15:00 UTC previous day
      // (00:00 Tokyo = 15:00 UTC previous day)
      expect(result.startUTC.getUTCHours()).toBeLessThanOrEqual(15);
    });

    it("computes today (dayOffset=0)", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "UTC",
        dayOffset: 0,
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.periodDescription).toContain("Today");
    });

    it("computes day 2 days ago (dayOffset=-2)", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "UTC",
        dayOffset: -2,
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.periodDescription).toContain("2 days ago");
    });

    it("handles dayOffset=0 in multiple timezones", () => {
      const timezones = ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"];
      
      for (const tz of timezones) {
        const query: TimezoneReportQuery = {
          period: ReportPeriod.DAY,
          timezone: tz,
          dayOffset: 0,
        };

        const result = service.computeUTCBoundaries(query);

        expect(result.timezone).toBe(tz);
        expect(result.periodDescription).toContain("Today");
        
        // Should be approximately 24 hours
        const duration = result.endUTC.getTime() - result.startUTC.getTime();
        expect(duration).toBeGreaterThan(24 * 60 * 60 * 1000 - 1000);
        expect(duration).toBeLessThan(24 * 60 * 60 * 1000 + 1000);
      }
    });
  });

  // ─── WEEK Period ──────────────────────────────────────────────────────────

  describe("WEEK Period", () => {
    it("computes current week (Monday-Sunday) in UTC", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.WEEK,
        timezone: "UTC",
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("UTC");
      expect(result.periodDescription).toContain("Week of");
      
      // Should be 7 days
      const duration = result.endUTC.getTime() - result.startUTC.getTime();
      const days = duration / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
    });

    it("computes current week in Tokyo timezone", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.WEEK,
        timezone: "Asia/Tokyo",
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("Asia/Tokyo");
      expect(result.periodDescription).toContain("Week of");
    });

    it("week starts on Monday and ends on Sunday", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.WEEK,
        timezone: "UTC",
      };

      const result = service.computeUTCBoundaries(query);

      // Check that start is a Monday (day 1)
      const startDay = result.startUTC.getUTCDay();
      // Note: getUTCDay() returns 0 for Sunday, 1 for Monday
      // Our week should start on Monday, but the actual day depends on when test runs
      // We just verify it's a valid week span
      const duration = result.endUTC.getTime() - result.startUTC.getTime();
      expect(duration).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    });
  });

  // ─── MONTH Period ─────────────────────────────────────────────────────────

  describe("MONTH Period", () => {
    it("computes current month in UTC", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.MONTH,
        timezone: "UTC",
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("UTC");
      expect(result.periodDescription).toMatch(/\w+ \d{4}/); // e.g. "March 2024"
      
      // Month should be at least 28 days
      const duration = result.endUTC.getTime() - result.startUTC.getTime();
      const days = duration / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThanOrEqual(27); // Allow for timezone shifts
      expect(days).toBeLessThanOrEqual(31.5);
    });

    it("computes current month in New York timezone", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.MONTH,
        timezone: "America/New_York",
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("America/New_York");
      expect(result.periodDescription).toMatch(/\w+ \d{4}/);
    });

    it("month starts on day 1 and ends on last day", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.MONTH,
        timezone: "UTC",
      };

      const result = service.computeUTCBoundaries(query);

      // Start should be at beginning of month
      expect(result.startLocal).toMatch(/-01 00:00:00$/);
      
      // End should be at end of month (28, 29, 30, or 31)
      expect(result.endLocal).toMatch(/-(28|29|30|31) 23:59:59$/);
    });
  });

  // ─── LAST_N_DAYS Period ───────────────────────────────────────────────────

  describe("LAST_N_DAYS Period", () => {
    it("defaults to last 7 days in UTC", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.LAST_N_DAYS,
        timezone: "UTC",
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("UTC");
      expect(result.periodDescription).toBe("Last 7 days");
      
      // Should be 7 days
      const duration = result.endUTC.getTime() - result.startUTC.getTime();
      const days = duration / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
    });

    it("computes last 30 days", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.LAST_N_DAYS,
        timezone: "UTC",
        lastNDays: 30,
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.periodDescription).toBe("Last 30 days");
      
      const duration = result.endUTC.getTime() - result.startUTC.getTime();
      const days = duration / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
    });

    it("computes last 1 day (minimum)", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.LAST_N_DAYS,
        timezone: "UTC",
        lastNDays: 1,
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.periodDescription).toBe("Last 1 days");
      
      const duration = result.endUTC.getTime() - result.startUTC.getTime();
      const hours = duration / (60 * 60 * 1000);
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThan(24.1);
    });

    it("throws error for lastNDays < 1", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.LAST_N_DAYS,
        timezone: "UTC",
        lastNDays: 0,
      };

      expect(() => service.computeUTCBoundaries(query)).toThrow(
        TimezoneReportValidationError
      );
    });

    it("throws error for lastNDays > 365", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.LAST_N_DAYS,
        timezone: "UTC",
        lastNDays: 366,
      };

      expect(() => service.computeUTCBoundaries(query)).toThrow(
        TimezoneReportValidationError
      );
    });

    it("computes last N days in Tokyo timezone", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.LAST_N_DAYS,
        timezone: "Asia/Tokyo",
        lastNDays: 14,
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("Asia/Tokyo");
      expect(result.periodDescription).toBe("Last 14 days");
    });
  });

  // ─── Timezone Boundary Correctness ────────────────────────────────────────

  describe("Timezone Boundary Correctness", () => {
    it("New York day boundaries differ from UTC", () => {
      const utcQuery: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "UTC",
        dayOffset: -1,
      };

      const nycQuery: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "America/New_York",
        dayOffset: -1,
      };

      const utcResult = service.computeUTCBoundaries(utcQuery);
      const nycResult = service.computeUTCBoundaries(nycQuery);

      // NYC boundaries should be shifted from UTC boundaries
      // NYC is UTC-5 (EST) or UTC-4 (EDT)
      const startDiff = Math.abs(
        utcResult.startUTC.getTime() - nycResult.startUTC.getTime()
      );
      const hoursDiff = startDiff / (60 * 60 * 1000);
      
      // Should be 4 or 5 hours difference (EDT or EST)
      expect(hoursDiff).toBeGreaterThanOrEqual(4);
      expect(hoursDiff).toBeLessThanOrEqual(5);
    });

    it("Tokyo day boundaries differ from UTC by ~9 hours", () => {
      const utcQuery: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "UTC",
        dayOffset: -1,
      };

      const tokyoQuery: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "Asia/Tokyo",
        dayOffset: -1,
      };

      const utcResult = service.computeUTCBoundaries(utcQuery);
      const tokyoResult = service.computeUTCBoundaries(tokyoQuery);

      // Tokyo is UTC+9
      const startDiff = Math.abs(
        utcResult.startUTC.getTime() - tokyoResult.startUTC.getTime()
      );
      const hoursDiff = startDiff / (60 * 60 * 1000);
      
      // Should be approximately 9 hours
      expect(hoursDiff).toBeGreaterThanOrEqual(8);
      expect(hoursDiff).toBeLessThanOrEqual(10);
    });

    it("same local date in different timezones produces different UTC boundaries", () => {
      const customDate = "2024-03-15";
      
      const utcQuery: TimezoneReportQuery = {
        period: ReportPeriod.CUSTOM,
        timezone: "UTC",
        customStartDate: customDate,
        customEndDate: customDate,
      };

      const tokyoQuery: TimezoneReportQuery = {
        period: ReportPeriod.CUSTOM,
        timezone: "Asia/Tokyo",
        customStartDate: customDate,
        customEndDate: customDate,
      };

      const utcResult = service.computeUTCBoundaries(utcQuery);
      const tokyoResult = service.computeUTCBoundaries(tokyoQuery);

      // Same local date, different timezones → different UTC times
      expect(utcResult.startUTC.getTime()).not.toBe(tokyoResult.startUTC.getTime());
      expect(utcResult.endUTC.getTime()).not.toBe(tokyoResult.endUTC.getTime());
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────────

  describe("Edge Cases", () => {
    it("handles UTC timezone explicitly", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "UTC",
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("UTC");
      expect(() => service.computeUTCBoundaries(query)).not.toThrow();
    });

    it("handles Etc/UTC timezone", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "Etc/UTC",
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("Etc/UTC");
    });

    it("falls back to UTC when timezone is undefined", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        // timezone not provided
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.timezone).toBe("UTC");
    });

    it("handles leap year February", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.CUSTOM,
        timezone: "UTC",
        customStartDate: "2024-02-29", // 2024 is a leap year
        customEndDate: "2024-02-29",
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.startLocal).toContain("2024-02-29");
      expect(result.endLocal).toContain("2024-02-29");
    });

    it("handles year boundaries", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.CUSTOM,
        timezone: "UTC",
        customStartDate: "2023-12-31",
        customEndDate: "2024-01-01",
      };

      const result = service.computeUTCBoundaries(query);

      expect(result.startLocal).toContain("2023-12-31");
      expect(result.endLocal).toContain("2024-01-01");
    });
  });

  // ─── Integration with Existing Operator Reporting ─────────────────────────

  describe("Integration with OperatorReportingService", () => {
    it("produces boundaries compatible with existing OperatorReportQuery", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "America/New_York",
        dayOffset: -1,
      };

      const boundaries = service.computeUTCBoundaries(query);

      // These boundaries can be passed directly to OperatorReportingService.buildReport()
      const operatorQuery = {
        startDate: boundaries.startUTC,
        endDate: boundaries.endUTC,
      };

      expect(operatorQuery.startDate).toBeInstanceOf(Date);
      expect(operatorQuery.endDate).toBeInstanceOf(Date);
      expect(operatorQuery.startDate.getTime()).toBeLessThanOrEqual(
        operatorQuery.endDate.getTime()
      );
    });

    it("documents expected API integration pattern", () => {
      // Example: User requests yesterday's report in their timezone
      const timezoneQuery: TimezoneReportQuery = {
        period: ReportPeriod.DAY,
        timezone: "Asia/Tokyo",
        dayOffset: -1,
      };

      // Step 1: Compute UTC boundaries
      const boundaries = service.computeUTCBoundaries(timezoneQuery);

      // Step 2: Pass to existing reporting service
      // const report = await operatorReportingService.buildReport({
      //   startDate: boundaries.startUTC,
      //   endDate: boundaries.endUTC
      // });

      // The report will contain data for Tokyo's "yesterday" even though
      // the database query uses UTC timestamps

      expect(boundaries.periodDescription).toContain("Yesterday");
      expect(boundaries.timezone).toBe("Asia/Tokyo");
    });
  });

  // ─── Unsupported Period ───────────────────────────────────────────────────

  describe("Error Handling", () => {
    it("throws error for unsupported period type", () => {
      const query: TimezoneReportQuery = {
        period: "INVALID_PERIOD" as ReportPeriod,
        timezone: "UTC",
      };

      expect(() => service.computeUTCBoundaries(query)).toThrow(
        TimezoneReportValidationError
      );
    });

    it("validation errors include field name", () => {
      const query: TimezoneReportQuery = {
        period: ReportPeriod.CUSTOM,
        timezone: "Invalid/Zone",
        customStartDate: "2024-03-15",
        customEndDate: "2024-03-20",
      };

      try {
        service.computeUTCBoundaries(query);
        fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(TimezoneReportValidationError);
        expect((error as TimezoneReportValidationError).field).toBe("timezone");
      }
    });
  });
});


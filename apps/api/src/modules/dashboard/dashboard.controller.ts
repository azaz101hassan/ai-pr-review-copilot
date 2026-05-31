import { Controller, Get, Param, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { FilterSpecDto } from './types/dto/filter-spec.dto';
import { SettingsResponseDto } from './types/dto/settings-response.dto';
import {
  AnalyticsResponse,
  FilterOptionsResponse,
  ReviewDetailResponse,
  ReviewListResponse,
} from './types/dashboard-response.types';

// Read-only REST endpoints for the dashboard frontend pages.
// All routes are under the /dashboard prefix.
//
// The global ThrottlerGuard (30 req/60s per IP) applies automatically.
// The global ValidationPipe (transform + whitelist + forbidNonWhitelisted)
// enforces the FilterSpecDto constraints on every query-param endpoint.
//
// This controller is intentionally thin — all query orchestration and
// business logic live in DashboardService.
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  // GET /dashboard/reviews
  //
  // Returns a paginated list of reviews joined with PR metadata.
  // Optional filter params: repo, author, pr_node_id, since (epoch ms),
  // until (epoch ms), offset, limit.
  @Get('reviews')
  getReviews(@Query() dto: FilterSpecDto): ReviewListResponse {
    return this.dashboard.getReviews(dto);
  }

  // GET /dashboard/reviews/:id
  //
  // Returns the full review with its findings and hydrated retrieved chunks.
  // Missing chunks return { id, missing: true } placeholders instead of 500.
  // Returns 404 when the review id does not exist.
  @Get('reviews/:id')
  async getReviewDetail(@Param('id') id: string): Promise<ReviewDetailResponse> {
    return this.dashboard.getReviewDetail(id);
  }

  // GET /dashboard/analytics
  //
  // Returns aggregated metrics for the matched filter window:
  // status breakdown, severity rollup, top-10 rules, latency p50/p95,
  // and token totals. Standalone rows are excluded from every metric.
  // An empty filter window returns zero-everywhere without erroring.
  @Get('analytics')
  getAnalytics(@Query() dto: FilterSpecDto): AnalyticsResponse {
    return this.dashboard.getAnalytics(dto);
  }

  // GET /dashboard/filters
  //
  // Returns distinct repos, authors, and recent PRs for populating filter
  // dropdowns. Each list is bounded to LIMIT 100.
  @Get('filters')
  getFilterOptions(@Query() dto: FilterSpecDto): FilterOptionsResponse {
    return this.dashboard.getFilterOptions(dto);
  }

  // GET /dashboard/settings
  //
  // Returns the positive-allowlist configuration view (R5).
  // Never returns secrets — the service builds the DTO explicitly from
  // ConfigService fields rather than passing the raw ConfigService to the
  // serializer.
  @Get('settings')
  async getSettings(): Promise<SettingsResponseDto> {
    return this.dashboard.getSettings();
  }
}

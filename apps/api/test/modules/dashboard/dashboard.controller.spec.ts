import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { DashboardController } from '@/modules/dashboard/dashboard.controller';
import { DashboardService } from '@/modules/dashboard/dashboard.service';
import { FilterSpecDto } from '@/modules/dashboard/types/dto/filter-spec.dto';
import { SettingsResponseDto } from '@/modules/dashboard/types/dto/settings-response.dto';
import {
  AnalyticsResponse,
  FilterOptionsResponse,
  ReviewDetailResponse,
  ReviewListResponse,
} from '@/modules/dashboard/types/dashboard-response.types';

// ---------------------------------------------------------------------------
// Stub DashboardService
// ---------------------------------------------------------------------------

const mockService = {
  getReviews: jest.fn(),
  getReviewDetail: jest.fn(),
  getAnalytics: jest.fn(),
  getFilterOptions: jest.fn(),
  getSettings: jest.fn(),
};

const emptyAnalytics: AnalyticsResponse = {
  statusBreakdown: { completed: 0, failed: 0, in_progress: 0 },
  severityRollup: { error: 0, warning: 0, info: 0 },
  topRules: [],
  tokenTotals: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  latency: { p50: null, p95: null },
};

describe('DashboardController', () => {
  let controller: DashboardController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DashboardController],
      providers: [{ provide: DashboardService, useValue: mockService }],
    }).compile();

    controller = module.get(DashboardController);
  });

  // ---------------------------------------------------------------------------
  // getReviews
  // ---------------------------------------------------------------------------

  describe('getReviews', () => {
    it('delegates to service.getReviews and returns the result', () => {
      const expected: ReviewListResponse = {
        items: [],
        total: 0,
        offset: 0,
        limit: 50,
      };
      mockService.getReviews.mockReturnValue(expected);

      const dto = new FilterSpecDto();
      const result = controller.getReviews(dto);

      expect(mockService.getReviews).toHaveBeenCalledWith(dto);
      expect(result).toBe(expected);
    });
  });

  // ---------------------------------------------------------------------------
  // getReviewDetail
  // ---------------------------------------------------------------------------

  describe('getReviewDetail', () => {
    it('delegates to service.getReviewDetail and returns the result', async () => {
      const expected: ReviewDetailResponse = {
        review: { id: 'r1' } as never,
        findings: [],
        retrievedChunks: [],
      };
      mockService.getReviewDetail.mockReturnValue(expected);

      const result = await controller.getReviewDetail('r1');

      expect(mockService.getReviewDetail).toHaveBeenCalledWith('r1');
      expect(result).toBe(expected);
    });

    it('propagates NotFoundException from service', async () => {
      mockService.getReviewDetail.mockImplementation(() => {
        throw new NotFoundException('Review xyz not found');
      });

      await expect(controller.getReviewDetail('xyz')).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // getAnalytics
  // ---------------------------------------------------------------------------

  describe('getAnalytics', () => {
    it('delegates to service.getAnalytics and returns the aggregate', () => {
      mockService.getAnalytics.mockReturnValue(emptyAnalytics);

      const dto = new FilterSpecDto();
      const result = controller.getAnalytics(dto);

      expect(mockService.getAnalytics).toHaveBeenCalledWith(dto);
      expect(result).toBe(emptyAnalytics);
    });
  });

  // ---------------------------------------------------------------------------
  // getFilterOptions
  // ---------------------------------------------------------------------------

  describe('getFilterOptions', () => {
    it('delegates to service.getFilterOptions and returns the options', () => {
      const expected: FilterOptionsResponse = {
        repos: ['org/repo'],
        authors: ['alice'],
        recentPrs: [],
      };
      mockService.getFilterOptions.mockReturnValue(expected);

      const dto = new FilterSpecDto();
      const result = controller.getFilterOptions(dto);

      expect(mockService.getFilterOptions).toHaveBeenCalledWith(dto);
      expect(result).toBe(expected);
    });
  });

  // ---------------------------------------------------------------------------
  // getSettings
  // ---------------------------------------------------------------------------

  describe('getSettings', () => {
    it('delegates to service.getSettings and returns the DTO', async () => {
      const expected = new SettingsResponseDto({
        model: 'claude-haiku',
        embeddingModel: 'voyage-code-3',
        chromaCollection: 'code-style-rules',
        knowledgeSources: [],
        severityGate: { allowed: ['error', 'warning', 'info'], default: 'warning' },
      });
      mockService.getSettings.mockResolvedValue(expected);

      const result = await controller.getSettings();

      expect(mockService.getSettings).toHaveBeenCalled();
      expect(result).toBe(expected);
    });
  });
});

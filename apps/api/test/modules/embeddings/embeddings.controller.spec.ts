import { EmbeddingsController } from '@/modules/embeddings/embeddings.controller';
import { EmbeddingsService, SearchHit } from '@/modules/embeddings/embeddings.service';
import { SearchRequestDto } from '@/modules/embeddings/types/dto/search-request.dto';

function makeService(hits: SearchHit[] = []): jest.Mocked<EmbeddingsService> {
  return {
    indexCorpus: jest.fn(),
    search: jest.fn().mockResolvedValue(hits),
  } as unknown as jest.Mocked<EmbeddingsService>;
}

describe('EmbeddingsController', () => {
  it('delegates to EmbeddingsService.search and wraps the result in { hits }', async () => {
    const hits: SearchHit[] = [
      {
        rule_id: 'eqeqeq',
        source: 'airbnb-eslint',
        score: 0.9,
        title: 'Require ===',
        document: 'body',
        metadata: {},
      },
    ];
    const service = makeService(hits);
    const controller = new EmbeddingsController(service);

    const dto = Object.assign(new SearchRequestDto(), { diff: 'some diff', k: 5 });
    const result = await controller.search(dto);

    expect(service.search).toHaveBeenCalledWith('some diff', { k: 5 });
    expect(result).toEqual({ hits });
  });

  it('passes undefined k through to the service (service defaults to 10)', async () => {
    const service = makeService([]);
    const controller = new EmbeddingsController(service);
    const dto = Object.assign(new SearchRequestDto(), { diff: 'some diff' });

    await controller.search(dto);

    expect(service.search).toHaveBeenCalledWith('some diff', { k: undefined });
  });
});

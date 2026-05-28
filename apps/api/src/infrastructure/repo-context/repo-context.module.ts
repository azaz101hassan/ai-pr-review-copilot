import { Module } from '@nestjs/common';
import { REPO_CONTEXT_PROVIDER } from '@/modules/reviews/types/repo-context-provider';
import { NullRepoContextProvider } from './null-repo-context.provider';

// Day-4 wiring: the HTTP path resolves `IRepoContextProvider` to
// the deterministic-degraded `NullRepoContextProvider` so the agent
// loop runs with truthful "no context available" results rather
// than crashing the constructor injection. The CLI bypasses this
// module and instantiates `FilesystemRepoContextProvider` directly
// against the resolved `--repo` directory (it has the absolute path
// at hand; no DI needed). Day-5 swaps the binding here to
// `GitHubRepoContextProvider`.
@Module({
  providers: [
    {
      provide: REPO_CONTEXT_PROVIDER,
      useClass: NullRepoContextProvider,
    },
  ],
  exports: [REPO_CONTEXT_PROVIDER],
})
export class RepoContextModule {}

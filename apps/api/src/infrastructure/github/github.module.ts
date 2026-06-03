import { Module } from '@nestjs/common';
import { GITHUB_AUTH_PROVIDER } from '@/modules/reviews/types';
import { AppInstallationAuthProvider } from './app-installation-auth.provider';
import { GitHubAppService } from './github-app.service';

// GitHub infrastructure: binds GITHUB_AUTH_PROVIDER to the
// `AppInstallationAuthProvider` implementation (App-installation auth
// via @octokit/auth-app) and registers `GitHubAppService` whose
// `onModuleInit` runs the GET /app boot probe. Consumers
// (`ReviewsProcessor`) inject `IGithubAuthProvider`; swapping to a
// future PAT-mode implementation is a one-line `useClass` change
// here, no service-code change.
//
// `GitHubAppService` is not exported because nothing outside this
// module needs to depend on it — it earns its keep by running once
// at boot. A future health surface that wants to re-run the probe
// would inject it directly from this module via `exports: [...]`.

@Module({
  providers: [
    {
      provide: GITHUB_AUTH_PROVIDER,
      useClass: AppInstallationAuthProvider,
    },
    GitHubAppService,
  ],
  exports: [GITHUB_AUTH_PROVIDER],
})
export class GithubModule {}

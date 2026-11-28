import { httpBucket, type HttpBucketEnv } from "./http-bucket";
import {
  authorized,
  failure,
  siteOperation,
  type OperationsEnv,
} from "./operations";
import { serveSdk, type SdkEnv } from "./sdk";
import { SiteData as RuntimeSiteData, type SiteDataEnv } from "./site";
import { dataApi, type WebsiteEnv } from "./website";

// The runtime as naru-dev runs it, under workerd on the developer's machine
// (dev/scripts/build-worker.mjs): the Data SDK's files (sdk.ts), the data API
// and live connections (website.ts), and, with the bearer secret naru-dev
// gives it, the site operations (operations.ts) it publishes `_naru/` and
// renders routes with. naru-dev serves the site's pages itself. Both of the
// buckets a site's object reads are naru-dev's one local folder
// (http-bucket.ts): their keys never meet.

type DevEnv = OperationsEnv &
  SdkEnv &
  WebsiteEnv &
  HttpBucketEnv &
  Pick<SiteDataEnv, "LOADER"> & {
    PLATFORM_DOMAIN: string;
    EDGE_WORKER_SECRET: string;
  };

const withBucket = <T extends HttpBucketEnv>(env: T) => {
  const bucket = httpBucket(env) as unknown as R2Bucket;
  return { ...env, SITE_FILES: bucket, PRIVATE_FILES: bucket };
};

export class SiteData extends RuntimeSiteData {
  constructor(ctx: DurableObjectState, env: DevEnv) {
    super(ctx, withBucket(env));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    // Everything here is the platform's, as on sdk.naru.pub.
    url.hostname = `sdk.${env.PLATFORM_DOMAIN}`;
    const platform = new Request(url, request) as Request<
      unknown,
      IncomingRequestCfProperties
    >;
    if (url.pathname.startsWith("/sdk/")) return serveSdk(platform, env);
    const data = dataApi(platform, withBucket(env), ctx);
    if (data) return data;
    if (!(await authorized(platform, env.EDGE_WORKER_SECRET)))
      return failure(401, "Unauthorized.");
    return (
      (await siteOperation(platform, env, ctx)) ?? failure(404, "Not found.")
    );
  },
} satisfies ExportedHandler<DevEnv>;

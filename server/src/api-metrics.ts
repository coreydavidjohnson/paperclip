import type { RequestHandler } from "express";

// No URL, query, user, company, task, run or error text enters a label. Route
// templates are Express registration strings. Mounts not in this fixed list
// collapse rather than exposing a caller-supplied parameter in req.baseUrl.
const STATIC_MOUNTS = new Set(["", "/api", "/api/health", "/api/auth", "/api/cloud", "/api/companies"]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5, 10, 30, 60];
type Failure = "lease_loss" | "disposition_failure";
type Sample = { labels: string; buckets: number[]; count: number; sum: number };

export interface ApiMetrics {
  middleware: RequestHandler;
  failure(reason: Failure): void;
  render(): string;
}

export function createApiMetrics(): ApiMetrics {
  const startedAt = Date.now() / 1000 - process.uptime();
  const samples = new Map<string, Sample>();
  const failures: Record<Failure, number> = { lease_loss: 0, disposition_failure: 0 };
  const middleware: RequestHandler = (req, res, next) => {
    // Also exclude scrape overhead. Unlike req.url, originalUrl remains stable
    // when Express enters/restores mounted routers.
    const path = req.originalUrl.split("?", 1)[0];
    if (!path.startsWith("/api/") || path === "/api/health/metrics") { next(); return; }
    const start = performance.now();
    // Express assigns route while the matched mount is still in baseUrl, then
    // restores baseUrl before an app-level error handler responds. Capture at
    // assignment, not finish, so thrown 4xx/5xx keep the same label as success.
    let route = "unmatched";
    let matchedRoute = req.route;
    Object.defineProperty(req, "route", {
      configurable: true,
      enumerable: true,
      get: () => matchedRoute,
      set: (value) => {
        matchedRoute = value;
        if (typeof value?.path === "string") {
          const base = STATIC_MOUNTS.has(req.baseUrl) ? req.baseUrl : "/api/:mount";
          route = (base + value.path).slice(0, 256);
        }
      },
    });
    let observed = false;
    const observe = () => {
      if (observed) return;
      observed = true;
      const method = METHODS.has(req.method) ? req.method : "OTHER";
      const status = !res.writableFinished ? "aborted" : String(res.statusCode);
      // Cap unexpected runtime-generated registrations. Ordinary routes are
      // bounded by source; this is a last fence for plugin registrations.
      const labelsFor = (r: string) => `method=${JSON.stringify(method)},route=${JSON.stringify(r)},status=${JSON.stringify(status)}`;
      let labels = labelsFor(route);
      if (!samples.has(labels) && samples.size >= 512) labels = labelsFor("overflow");
      const sample = samples.get(labels) ?? { labels, buckets: BUCKETS.map(() => 0), count: 0, sum: 0 };
      const seconds = Math.max(0, (performance.now() - start) / 1000);
      sample.count++;
      sample.sum += seconds;
      BUCKETS.forEach((bound, i) => { if (seconds <= bound) sample.buckets[i]++; });
      samples.set(labels, sample);
    };
    res.once("finish", observe);
    res.once("close", observe);
    next();
  };
  return {
    middleware,
    failure(reason: Failure) { failures[reason]++; },
    render() {
      const name = "paperclip_api_request_duration_seconds";
      const lines = [
        `# HELP ${name} API response time including parsing, authorization and persistence; aborted requests have status=aborted.`,
        `# TYPE ${name} histogram`,
      ];
      for (const sample of samples.values()) {
        BUCKETS.forEach((bound, i) => lines.push(`${name}_bucket{${sample.labels},le="${bound}"} ${sample.buckets[i]}`));
        lines.push(`${name}_bucket{${sample.labels},le="+Inf"} ${sample.count}`);
        lines.push(`${name}_count{${sample.labels}} ${sample.count}`);
        lines.push(`${name}_sum{${sample.labels}} ${sample.sum}`);
      }
      lines.push("# HELP paperclip_process_start_time_seconds Process start Unix time; use Kubernetes metrics for container restarts.",
        "# TYPE paperclip_process_start_time_seconds gauge", `paperclip_process_start_time_seconds ${startedAt}`,
        "# HELP paperclip_control_failures_total Controller failure events observed by this process.",
        "# TYPE paperclip_control_failures_total counter");
      for (const reason of ["lease_loss", "disposition_failure"] as const) {
        lines.push(`paperclip_control_failures_total{reason="${reason}"} ${failures[reason]}`);
      }
      return lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
    },
  };
}

export const apiMetrics: ApiMetrics = createApiMetrics();

import { Log } from "../util/log"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono } from "hono"
import { compress } from "hono/compress"
import { cors } from "hono/cors"
import { basicAuth } from "hono/basic-auth"
import z from "zod"
import { Auth } from "../auth"
import { Flag } from "../flag/flag"
import { ProviderID } from "../provider/schema"
import { WorkspaceRouterMiddleware } from "./router"
import { websocket } from "hono/bun"
import { errors } from "./error"
import { GlobalRoutes } from "./routes/global"
import { MDNS } from "./mdns"
import { lazy } from "@/util/lazy"
import { errorHandler } from "./middleware"
import { InstanceRoutes } from "./instance"
import { initProjectors } from "./projectors"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

initProjectors()

const COPILOT_HEADERS = {
  "Editor-Version": "vscode/1.107.0",
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
  Accept: "application/json",
}

async function fetchCopilotQuota(token: string) {
  const headers = { ...COPILOT_HEADERS, Authorization: `token ${token}` }
  const [user, quota] = await Promise.all([
    fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "User-Agent": "opencode" },
    }).then((r) => (r.ok ? (r.json() as Promise<{ login: string; name?: string }>) : undefined)),
    fetch("https://api.github.com/copilot_internal/user", { headers }).then((r) =>
      r.ok ? (r.json() as Promise<Record<string, any>>) : undefined,
    ),
  ])
  const snap = quota?.quota_snapshots?.premium_interactions ?? quota?.quota_snapshots?.chat
  return {
    username: user?.login ?? "",
    name: user?.name ?? undefined,
    plan: (quota?.copilot_plan as string) ?? "unknown",
    percent: (snap?.percent_remaining as number) ?? -1,
    remaining: (snap?.remaining as number) ?? -1,
    entitlement: (snap?.entitlement as number) ?? -1,
    unlimited: (snap?.unlimited as boolean) ?? false,
    reset: (quota?.quota_reset_date as string) ?? "",
  }
}

export namespace Server {
  const log = Log.create({ service: "server" })

  const zipped = compress()

  const skipCompress = (path: string, method: string) => {
    if (path === "/event" || path === "/global/event" || path === "/global/sync-event") return true
    if (method === "POST" && /\/session\/[^/]+\/(message|prompt_async)$/.test(path)) return true
    return false
  }

  export const Default = lazy(() => ControlPlaneRoutes())

  export const ControlPlaneRoutes = (opts?: { cors?: string[] }): Hono => {
    const app = new Hono()
    return app
      .onError(errorHandler(log))
      .use((c, next) => {
        // Allow CORS preflight requests to succeed without auth.
        // Browser clients sending Authorization headers will preflight with OPTIONS.
        if (c.req.method === "OPTIONS") return next()
        const password = Flag.OPENCODE_SERVER_PASSWORD
        if (!password) return next()
        const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
        return basicAuth({ username, password })(c, next)
      })
      .use(async (c, next) => {
        const skip = c.req.path === "/log"
        if (!skip) {
          log.info("request", {
            method: c.req.method,
            path: c.req.path,
          })
        }
        const timer = log.time("request", {
          method: c.req.method,
          path: c.req.path,
        })
        await next()
        if (!skip) {
          timer.stop()
        }
      })
      .use(
        cors({
          maxAge: 86_400,
          origin(input) {
            if (!input) return

            if (input.startsWith("http://localhost:")) return input
            if (input.startsWith("http://127.0.0.1:")) return input
            if (
              input === "tauri://localhost" ||
              input === "http://tauri.localhost" ||
              input === "https://tauri.localhost"
            )
              return input

            // *.opencode.ai (https only, adjust if needed)
            if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) {
              return input
            }
            if (opts?.cors?.includes(input)) {
              return input
            }

            return
          },
        }),
      )
      .use((c, next) => {
        if (skipCompress(c.req.path, c.req.method)) return next()
        return zipped(c, next)
      })
      .route("/global", GlobalRoutes())
      .put(
        "/auth/:providerID",
        describeRoute({
          summary: "Set auth credentials",
          description: "Set authentication credentials",
          operationId: "auth.set",
          responses: {
            200: {
              description: "Successfully set authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: ProviderID.zod,
          }),
        ),
        validator("json", Auth.Info.zod),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          const info = c.req.valid("json")
          await Auth.set(providerID, info)
          return c.json(true)
        },
      )
      .delete(
        "/auth/:providerID",
        describeRoute({
          summary: "Remove auth credentials",
          description: "Remove authentication credentials",
          operationId: "auth.remove",
          responses: {
            200: {
              description: "Successfully removed authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: ProviderID.zod,
          }),
        ),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          await Auth.remove(providerID)
          return c.json(true)
        },
      )
      .get(
        "/auth",
        describeRoute({
          summary: "List all auth credentials",
          description: "List all stored authentication credentials",
          operationId: "auth.list",
          responses: {
            200: {
              description: "All authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.record(z.string(), Auth.Info.zod)),
                },
              },
            },
            ...errors(400),
          },
        }),
        async (c) => {
          const data = await Auth.all()
          return c.json(data)
        },
      )
      .get(
        "/auth/:providerID/accounts",
        describeRoute({
          summary: "List accounts for a provider",
          description: "List named accounts for a specific provider",
          operationId: "auth.accounts",
          responses: {
            200: {
              description: "Named accounts for the provider",
              content: {
                "application/json": {
                  schema: resolver(z.record(z.string(), Auth.Info.zod)),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: ProviderID.zod,
          }),
        ),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          const data = await Auth.accounts(providerID)
          return c.json(data)
        },
      )
      .post(
        "/auth/:providerID/activate/:label",
        describeRoute({
          summary: "Activate a named account",
          description: "Switch the active credentials for a provider to a named account",
          operationId: "auth.activate",
          responses: {
            200: {
              description: "Successfully activated account",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: ProviderID.zod,
            label: z.string(),
          }),
        ),
        async (c) => {
          const { providerID, label } = c.req.valid("param")
          await Auth.activate(providerID, label)
          return c.json(true)
        },
      )
      .get(
        "/auth/:providerID/quota",
        describeRoute({
          summary: "Get quota for active account",
          description: "Get GitHub Copilot quota and username for the active account of a provider",
          operationId: "auth.quota",
          responses: {
            200: {
              description: "Quota information",
              content: {
                "application/json": {
                  schema: resolver(
                    z.object({
                      username: z.string(),
                      name: z.string().optional(),
                      label: z.string().optional(),
                      plan: z.string(),
                      percent: z.number(),
                      remaining: z.number(),
                      entitlement: z.number(),
                      unlimited: z.boolean(),
                      reset: z.string(),
                    }),
                  ),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator("param", z.object({ providerID: ProviderID.zod })),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          const [info, accts] = await Promise.all([Auth.get(providerID), Auth.accounts(providerID)])
          if (!info || info.type !== "oauth") return c.json({ error: "No active OAuth account" }, 400)
          const q = await fetchCopilotQuota(info.refresh)
          const match = Object.entries(accts).find(([, v]) => v.type === "oauth" && v.refresh === info.refresh)
          const label = match ? match[0].slice(providerID.length + 1) : undefined
          return c.json({ ...q, label })
        },
      )
      .get(
        "/auth/:providerID/quota/all",
        describeRoute({
          summary: "Get quota for all named accounts",
          description: "Get GitHub Copilot quota and username for every named account of a provider",
          operationId: "auth.quotaAll",
          responses: {
            200: {
              description: "Quota per account label",
              content: {
                "application/json": {
                  schema: resolver(z.record(z.string(), z.any())),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator("param", z.object({ providerID: ProviderID.zod })),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          const [active, accts] = await Promise.all([Auth.get(providerID), Auth.accounts(providerID)])
          const result: Record<string, unknown> = {}
          const tasks: Promise<void>[] = []
          if (active && active.type === "oauth") {
            tasks.push(
              fetchCopilotQuota(active.refresh)
                .then((q) => {
                  result["__active__"] = q
                })
                .catch(() => {}),
            )
          }
          for (const [key, val] of Object.entries(accts)) {
            if (val.type !== "oauth") continue
            const label = key.slice(providerID.length + 1)
            tasks.push(
              fetchCopilotQuota(val.refresh)
                .then((q) => {
                  result[label] = q
                })
                .catch(() => {}),
            )
          }
          await Promise.all(tasks)
          return c.json(result)
        },
      )
      .get(
        "/doc",
        openAPIRouteHandler(app, {
          documentation: {
            info: {
              title: "opencode",
              version: "0.0.3",
              description: "opencode api",
            },
            openapi: "3.1.1",
          },
        }),
      )
      .use(
        validator(
          "query",
          z.object({
            directory: z.string().optional(),
            workspace: z.string().optional(),
          }),
        ),
      )
      .post(
        "/log",
        describeRoute({
          summary: "Write log",
          description: "Write a log entry to the server logs with specified level and metadata.",
          operationId: "app.log",
          responses: {
            200: {
              description: "Log entry written successfully",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "json",
          z.object({
            service: z.string().meta({ description: "Service name for the log entry" }),
            level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
            message: z.string().meta({ description: "Log message" }),
            extra: z
              .record(z.string(), z.any())
              .optional()
              .meta({ description: "Additional metadata for the log entry" }),
          }),
        ),
        async (c) => {
          const { service, level, message, extra } = c.req.valid("json")
          const logger = Log.create({ service })

          switch (level) {
            case "debug":
              logger.debug(message, extra)
              break
            case "info":
              logger.info(message, extra)
              break
            case "error":
              logger.error(message, extra)
              break
            case "warn":
              logger.warn(message, extra)
              break
          }

          return c.json(true)
        },
      )
      .use(WorkspaceRouterMiddleware)
  }

  export function createApp(opts: { cors?: string[] }) {
    return ControlPlaneRoutes(opts)
  }

  export async function openapi() {
    // Build a fresh app with all routes registered directly so
    // hono-openapi can see describeRoute metadata (`.route()` wraps
    // handlers when the sub-app has a custom errorHandler, which
    // strips the metadata symbol).
    const app = ControlPlaneRoutes()
    InstanceRoutes(app)
    const result = await generateSpecs(app, {
      documentation: {
        info: {
          title: "opencode",
          version: "1.0.0",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  /** @deprecated do not use this dumb shit */
  export let url: URL

  export function listen(opts: {
    port: number
    hostname: string
    mdns?: boolean
    mdnsDomain?: string
    cors?: string[]
  }) {
    url = new URL(`http://${opts.hostname}:${opts.port}`)
    const app = ControlPlaneRoutes({ cors: opts.cors })
    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
      fetch: app.fetch,
      websocket: websocket,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port!, opts.mdnsDomain)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      if (shouldPublishMDNS) MDNS.unpublish()
      return originalStop(closeActiveConnections)
    }

    return server
  }
}

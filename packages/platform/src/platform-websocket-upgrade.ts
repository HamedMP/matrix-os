import { createConnection, type Socket } from 'node:net';
import { connect as createTlsConnection } from 'node:tls';
import type { IncomingMessage, Server } from 'node:http';
import type Dockerode from 'dockerode';
import {
  MATRIX_TELEMETRY_EVENTS,
  type MatrixTelemetryEvent,
} from '@matrix-os/observability';
import type { ClerkAuth } from './clerk-auth.js';
import {
  type PlatformDB,
  type UserMachineRecord,
  getAccessibleActiveUserMachineByClerkId,
  getContainer,
  getAccessibleRunningUserMachineByClerkId,
  getRunningUserMachineByHandle,
  getUserMachine,
} from './db.js';
import { canClerkUserAccessMachine } from './customer-vps-preview.js';
import type { EntitlementAccessDecision } from './profile-routing.js';
import {
  getWebSocketUpgradeToken,
  isAppDomainHost,
  isCodeDomainHost,
  isSafeWebSocketUpgradePath,
  isSessionRoutedHost,
  stripWebSocketUpgradeToken,
} from './ws-upgrade.js';
import { readRuntimeSlot } from './request-routing.js';
import { EDGE_SECRET_HEADER } from './session-routing-proxy.js';
import {
  buildExplicitVmWebSocketUpstreamPath,
  hasExplicitVmNativeAppStreamCapability,
  isNativeAppStreamPath,
  readExplicitVmWebSocketRoute,
  resolveAppDomainIdentity,
  type AppDomainIdentity,
} from './session-routing-identity.js';
import {
  buildPlatformWebSocketUpgradeHeaders,
  classifySessionRoutedHost,
  classifyWebSocketPath,
  getTrustedSessionRoutedWebSocketHost,
} from './session-routing-websocket.js';
import { resolveContainerEndpoint } from './container-endpoint.js';
import { describeError } from './platform-route-utils.js';
import { shouldVerifyCustomerVpsTls } from './customer-vps-tls.js';
import { handleInternalGeminiLiveProxyUpgrade } from './gemini-live-proxy.js';
import {
  buildCollaborationWebSocketUpgradeHeaders,
  isCollaborationWebSocketCandidate,
  isCollaborationWebSocketPath,
  type CollaborationWebSocketAuthorizer,
  type CollaborationWebSocketUpgrade,
} from './collaboration/websocket.js';

interface PlatformWebSocketTelemetry {
  capturePlatformEvent(event: MatrixTelemetryEvent, properties: Record<string, unknown>): void;
}

interface PlatformWebSocketEnv {
  GEMINI_API_KEY?: string;
  EDGE_ROUTER_SECRET?: string;
  [key: string]: string | undefined;
}

export interface RegisterPlatformWebSocketUpgradeHandlerOpts {
  server: Server;
  app: PlatformWebSocketTelemetry;
  db: PlatformDB;
  docker?: Dockerode;
  clerkAuth?: ClerkAuth;
  env: PlatformWebSocketEnv;
  platformSecret: string;
  platformJwtSecret: string;
  legacyContainerRoutingEnabled: boolean;
  codeServerPort: number;
  getRuntimeEntitlementDecision(env?: NodeJS.ProcessEnv): EntitlementAccessDecision;
  getRuntimeEntitlementDecisionForUser(
    db: PlatformDB,
    clerkUserId: string,
    env?: NodeJS.ProcessEnv,
    runtimeSlot?: string,
    provisioningClass?: string,
  ): Promise<EntitlementAccessDecision>;
  collaborationSockets?: CollaborationWebSocketAuthorizer;
}

export function registerPlatformWebSocketUpgradeHandler(
  opts: RegisterPlatformWebSocketUpgradeHandlerOpts,
): void {
  const {
    server,
    app,
    db,
    docker,
    clerkAuth,
    env,
    platformSecret,
    platformJwtSecret,
    legacyContainerRoutingEnabled,
    codeServerPort,
    getRuntimeEntitlementDecision,
    getRuntimeEntitlementDecisionForUser,
    collaborationSockets,
  } = opts;

  server.on('upgrade', async (req: IncomingMessage, socket, head) => {
    try {
      const handledInternalGeminiLive = await handleInternalGeminiLiveProxyUpgrade({
        req,
        socket: socket as Socket,
        head,
        db,
        platformSecret,
        geminiApiKey: env.GEMINI_API_KEY ?? '',
      });
      if (handledInternalGeminiLive) return;
    } catch (err: unknown) {
      console.warn('[platform] internal Gemini Live proxy failed:', describeError(err));
      app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_UPSTREAM_FAILED, {
        pathClass: 'internal-gemini-live',
        errorKind: err instanceof Error ? err.name : typeof err,
      });
      socket.destroy();
      return;
    }

    const path = req.url ?? '/';
    const host = getTrustedSessionRoutedWebSocketHost(
      req.headers.host,
      req.headers['x-forwarded-host'],
      req.headers[EDGE_SECRET_HEADER],
      env.EDGE_ROUTER_SECRET,
      path,
    );
    if (!isSessionRoutedHost(host)) {
      socket.destroy();
      return;
    }
    const isCodeDomain = isCodeDomainHost(host);
    const isAppDomain = isAppDomainHost(host);
    const isCollaborationCandidate = isAppDomain && isCollaborationWebSocketCandidate(path);
    const isCollaborationSocket = isAppDomain && isCollaborationWebSocketPath(path);
    if (isCollaborationCandidate && !isCollaborationSocket) {
      socket.destroy();
      return;
    }
    const hostClass = classifySessionRoutedHost(host);
    const explicitVmRoute = isAppDomain ? readExplicitVmWebSocketRoute(path) : null;
    let webSocketProxyPath = explicitVmRoute
      ? buildExplicitVmWebSocketUpstreamPath(path)
      : path;
    const pathClass = classifyWebSocketPath(webSocketProxyPath);
    if (isAppDomain && path.startsWith('/vm/') && !explicitVmRoute) {
      socket.destroy();
      return;
    }
    if (
      explicitVmRoute
      && isNativeAppStreamPath(explicitVmRoute.upstreamPath)
      && !hasExplicitVmNativeAppStreamCapability(req.method ?? '', explicitVmRoute)
    ) {
      socket.destroy();
      return;
    }

    const requestRuntimeSlot = explicitVmRoute?.runtimeSlot ?? readRuntimeSlot(webSocketProxyPath);
    const wsToken = getWebSocketUpgradeToken(webSocketProxyPath);
    let identity: AppDomainIdentity | null;
    try {
      identity = await resolveAppDomainIdentity({
        authHeader: req.headers.authorization as string | undefined,
        cookieHeader: req.headers.cookie,
        clerkAuth,
        db,
        platformJwtSecret,
        legacyContainerRoutingEnabled,
        allowUnroutedClerkIdentity: Boolean(explicitVmRoute),
        requestedHandle: explicitVmRoute?.handle,
        runtimeSlot: requestRuntimeSlot,
        wsToken,
        clerkPrincipalOnly: isCollaborationSocket,
      });
      if (
        !identity
        && explicitVmRoute
        && hasExplicitVmNativeAppStreamCapability(req.method ?? '', explicitVmRoute)
      ) {
        identity = {
          handle: explicitVmRoute.handle,
          userId: '',
          source: 'static-route',
        };
      }
    } catch (err: unknown) {
      console.warn(
        `[platform] websocket auth failed host=${host} pathClass=${pathClass} error=${describeError(err)}`,
      );
      app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_AUTH_FAILED, {
        hostClass,
        pathClass,
        runtimeSlot: requestRuntimeSlot,
        hasToken: Boolean(wsToken),
        hasCookie: Boolean(req.headers.cookie),
        errorKind: err instanceof Error ? err.name : typeof err,
      });
      socket.destroy();
      return;
    }
    if (!identity) {
      console.warn(`[platform] websocket unauthenticated host=${host} pathClass=${pathClass} hasCookie=${Boolean(req.headers.cookie)} hasToken=${Boolean(wsToken)}`);
      app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_UNAUTHENTICATED, {
        hostClass,
        pathClass,
        runtimeSlot: requestRuntimeSlot,
        hasToken: Boolean(wsToken),
        hasCookie: Boolean(req.headers.cookie),
      });
      socket.destroy();
      return;
    }

    let collaborationUpgrade: CollaborationWebSocketUpgrade | undefined;
    let runtimeSlot = identity.runtimeSlot ?? requestRuntimeSlot;
    let requestedActiveMachine: UserMachineRecord | undefined;
    let runningMachine: UserMachineRecord | undefined;
    if (isCollaborationSocket) {
      if (!collaborationSockets || !identity.userId) {
        socket.destroy();
        return;
      }
      try {
        collaborationUpgrade = await collaborationSockets.authorizeUpgrade({
          actorId: identity.userId,
          authentication: collaborationAuthentication(path, req.headers.authorization),
          rawPath: path,
          origin: firstHeader(req.headers.origin),
        });
      } catch (err: unknown) {
        console.warn(`[platform] collaboration websocket authorization failed error=${describeError(err)}`);
        socket.destroy();
        return;
      }
      const machineId = parseCollaborationRuntimeId(collaborationUpgrade.runtimeId);
      const authorityMachine = machineId ? await getUserMachine(db, machineId) : undefined;
      if (!authorityMachine || authorityMachine.status !== 'running' || !authorityMachine.publicIPv4
        || authorityMachine.clerkUserId !== collaborationUpgrade.ownerId) {
        socket.destroy();
        return;
      }
      runningMachine = authorityMachine;
      runtimeSlot = authorityMachine.runtimeSlot;
      webSocketProxyPath = collaborationUpgrade.upstreamPath;
    } else if (explicitVmRoute) {
      const explicitMachine = await getRunningUserMachineByHandle(
        db,
        explicitVmRoute.handle,
        explicitVmRoute.runtimeSlot,
      );
      if (!explicitMachine || (identity.userId && !canClerkUserAccessMachine(explicitMachine, identity.userId))) {
        socket.destroy();
        return;
      }
      runningMachine = explicitMachine;
    } else {
      runningMachine = identity.userId
        ? await getAccessibleRunningUserMachineByClerkId(db, identity.userId, runtimeSlot)
        : await getRunningUserMachineByHandle(db, identity.handle);
    }
    if (!runningMachine && identity.userId) {
      requestedActiveMachine = await getAccessibleActiveUserMachineByClerkId(db, identity.userId, runtimeSlot);
      if (!requestedActiveMachine) {
        const handleMachine = await getRunningUserMachineByHandle(db, identity.handle);
        if (handleMachine && canClerkUserAccessMachine(handleMachine, identity.userId)) {
          runningMachine = handleMachine;
        }
      }
    }
    if (runningMachine) {
      runtimeSlot = runningMachine.runtimeSlot;
    }
    const record = legacyContainerRoutingEnabled
      ? await getContainer(db, identity.handle)
      : undefined;
    if (!runningMachine && !record) { socket.destroy(); return; }
    const entitlement = runningMachine
      ? await getRuntimeEntitlementDecisionForUser(
        db,
        runningMachine.clerkUserId,
        env,
        runningMachine.runtimeSlot,
        runningMachine.provisioningClass,
      )
      : requestedActiveMachine
        ? await getRuntimeEntitlementDecisionForUser(
          db,
          requestedActiveMachine.clerkUserId,
          env,
          requestedActiveMachine.runtimeSlot,
          requestedActiveMachine.provisioningClass,
        )
        : getRuntimeEntitlementDecision(env);
    let activeUpstream: Socket | null = null;
    const onSocketError = () => activeUpstream?.destroy();
    socket.on('error', onSocketError);

    const buildUpgradeHeaders = (handle: string, includePlatformProof: boolean): string => (
      collaborationUpgrade
        ? buildCollaborationWebSocketUpgradeHeaders({
            incomingHeaders: req.headers,
            externalHost: host,
            signedProof: collaborationUpgrade.signedProof,
            signedPolicy: collaborationUpgrade.signedPolicy,
          })
        : buildPlatformWebSocketUpgradeHeaders({
        incomingHeaders: req.headers,
        externalHost: host,
        handle,
        userId: identity.userId,
        platformSecret,
        includePlatformProof: includePlatformProof && identity.source !== 'static-route',
        isCodeDomain,
      })
    );

    const writeUpgradeRequest = (
      upstream: Socket,
      upstreamHostHeader: string,
      headers: string,
    ): void => {
      if (!isSafeWebSocketUpgradePath(webSocketProxyPath)) {
        socket.destroy();
        upstream.destroy();
        return;
      }
      const upstreamPath = stripWebSocketUpgradeToken(webSocketProxyPath);
      upstream.write(
        `${req.method} ${upstreamPath} HTTP/1.1\r\nHost: ${upstreamHostHeader}\r\n${headers}\r\n\r\n`,
      );
      if (head.length > 0) upstream.write(head);

      upstream.pipe(socket);
      socket.pipe(upstream);
    };

    if (runningMachine) {
      if (!entitlement.runtimeProxyAllowed) {
        console.warn(
          `[platform] websocket runtime proxy denied by entitlement handle=${runningMachine.handle} pathClass=${pathClass}`,
        );
        app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_ENTITLEMENT_DENIED, {
          handle: runningMachine.handle,
          runtimeSlot,
          pathClass,
        });
        socket.destroy();
        return;
      }
      if (!runningMachine.publicIPv4) {
        console.warn(
          `[platform] websocket runtime proxy missing upstream address handle=${runningMachine.handle} pathClass=${pathClass}`,
        );
        socket.destroy();
        return;
      }
      const upstreamHostHeader = isCodeDomain ? host : 'app.matrix-os.com';
      const headers = buildUpgradeHeaders(runningMachine.handle, true);
      const upstreamServerName = upstreamHostHeader.split(':')[0] ?? upstreamHostHeader;
      const upstream = createTlsConnection({
        host: runningMachine.publicIPv4,
        port: 443,
        servername: upstreamServerName,
        rejectUnauthorized: shouldVerifyCustomerVpsTls(),
      }, () => {
        activeUpstream = upstream;
        writeUpgradeRequest(upstream, upstreamHostHeader, headers);
      });
      upstream.on('error', (err) => {
        upstream.destroy();
        console.warn(
          `[platform] websocket vps upstream failed handle=${runningMachine.handle} host=${runningMachine.publicIPv4} pathClass=${pathClass} error=${describeError(err)}`,
        );
        app.capturePlatformEvent(MATRIX_TELEMETRY_EVENTS.PLATFORM_WS_UPSTREAM_FAILED, {
          handle: runningMachine.handle,
          runtimeSlot,
          pathClass,
          errorKind: err instanceof Error ? err.name : typeof err,
        });
        socket.destroy();
      });
      return;
    }

    if (!record) { socket.destroy(); return; }
    if (!entitlement.runtimeProxyAllowed) {
      console.warn(
        `[platform] websocket legacy container proxy denied by entitlement handle=${record.handle} pathClass=${pathClass}`,
      );
      socket.destroy();
      return;
    }
    const connectUpstream = async (attempt: number): Promise<void> => {
      const endpoint = await resolveContainerEndpoint(docker, db, record.handle, record.containerId);
      if (!endpoint) {
        console.warn(
          `[platform] websocket upstream unresolved handle=${record.handle} attempt=${attempt + 1} pathClass=${pathClass}`,
        );
        socket.destroy();
        return;
      }

      let connected = false;
      const targetPort = isCodeDomain ? codeServerPort : 4000;
      const upstream = createConnection({ host: endpoint.host, port: targetPort }, () => {
        connected = true;
        activeUpstream = upstream;
        const upstreamHostHeader = isCodeDomain ? host : `${endpoint.host}:${targetPort}`;
        writeUpgradeRequest(
          upstream,
          upstreamHostHeader,
          buildUpgradeHeaders(record.handle, !isCodeDomain),
        );
      });

      upstream.on('error', (err) => {
        upstream.destroy();
        console.warn(
          `[platform] websocket upstream failed handle=${record.handle} attempt=${attempt + 1} host=${endpoint.host} source=${endpoint.source} containerId=${endpoint.containerId ?? 'null'} pathClass=${pathClass} error=${describeError(err)}`,
        );
        if (!connected && attempt === 0 && !socket.destroyed) {
          void connectUpstream(attempt + 1).catch((retryErr) => {
            console.error('[platform] websocket upstream retry fatal error:', describeError(retryErr));
            socket.destroy();
          });
          return;
        }
        socket.destroy();
      });
    };

    void connectUpstream(0).catch((err) => {
      console.error('[platform] websocket upstream fatal error:', describeError(err));
      socket.destroy();
    });
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function collaborationAuthentication(
  rawPath: string,
  authorization: string | string[] | undefined,
): 'session' | 'bearer' | 'ticket' {
  try {
    if (new URL(rawPath, 'https://platform.invalid').searchParams.has('ticket')) return 'ticket';
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      console.warn('[platform] collaboration websocket credential parse failed:', describeError(err));
    }
  }
  return firstHeader(authorization)?.startsWith('Bearer ') ? 'bearer' : 'session';
}

function parseCollaborationRuntimeId(runtimeId: string): string | null {
  const match = /^vps:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(runtimeId);
  return match?.[1] ?? null;
}

FROM node:22.22.1-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN pnpm install --frozen-lockfile --filter @aura/web...
COPY apps/web apps/web
COPY packages/shared-types packages/shared-types
ARG NEXT_PUBLIC_GATEWAY_URL
ARG NEXT_PUBLIC_GOOGLE_OIDC_ENABLED=false
ARG NEXT_PUBLIC_ENABLE_DEV_SESSION=false
ENV NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL
ENV NEXT_PUBLIC_GOOGLE_OIDC_ENABLED=$NEXT_PUBLIC_GOOGLE_OIDC_ENABLED
ENV NEXT_PUBLIC_ENABLE_DEV_SESSION=$NEXT_PUBLIC_ENABLE_DEV_SESSION
RUN pnpm --filter @aura/web build

FROM node:22.22.1-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
RUN groupadd --system --gid 10001 aura && useradd --system --uid 10001 --gid aura aura
COPY --from=build --chown=aura:aura /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=aura:aura /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=aura:aura /workspace/apps/web/public ./apps/web/public
USER aura
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]


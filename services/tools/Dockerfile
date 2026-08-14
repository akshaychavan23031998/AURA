FROM node:22.22.1-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY services/tools/package.json services/tools/package.json
RUN pnpm install --frozen-lockfile --filter @aura/tools...
COPY services/tools services/tools
RUN pnpm --filter @aura/tools build && pnpm --filter @aura/tools deploy --legacy --prod /runtime

FROM node:22.22.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 aura && useradd --system --uid 10001 --gid aura aura
COPY --from=build --chown=aura:aura /runtime ./
COPY --from=build --chown=aura:aura /workspace/services/tools/dist ./dist
USER aura
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4001/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

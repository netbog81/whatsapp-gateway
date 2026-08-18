FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
# @curandis/openbao-core arriva dal package registry GitLab (project 4), non
# più da un tarball in local-libs. Il registry è privato: la credenziale arriva
# come secret BuildKit, montata solo per la durata del RUN e mai scritta in un
# layer. È un deploy token con il solo scope read_package_registry.
#
# Il secret è montato come .npmrc DI PROGETTO e non in /root: un .npmrc nella
# working directory ha precedenza su quello utente, quindi montarlo in /root
# verrebbe scavalcato. Per lo stesso motivo il .npmrc del repo non viene più
# copiato nell'immagine.
RUN --mount=type=secret,id=npmrc,target=/app/.npmrc \
    npm ci

COPY tsconfig.json nest-cli.json ./
COPY src/ ./src/

RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN --mount=type=secret,id=npmrc,target=/app/.npmrc \
    npm ci --omit=dev

COPY --from=builder /app/dist ./dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/docs || exit 1

CMD ["node", "dist/main"]

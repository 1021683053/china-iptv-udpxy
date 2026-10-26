FROM node:22-alpine

WORKDIR /app

COPY server/*.mjs /app/server/
COPY iptv/ /app/iptv/
COPY browser/ /app/browser/
COPY logo/ /app/logo/
COPY aliases/logo/ /app/aliases/logo/

LABEL org.opencontainers.image.source="https://github.com/1021683053/china-iptv-udpxy"

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/server.mjs"]

# Build stage. Pinned to the BUILD platform, not the target one: the Angular
# output is static files and architecture-independent, so there is nothing to
# gain from emulating arm64 here. Without this the arm64 leg runs npm ci and
# ng build under QEMU and takes hours instead of minutes.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx ng build --configuration production

# Runtime stage — nginx serves the static build and reverse-proxies /api/v2/
FROM nginx:alpine
COPY --from=build /app/dist/qbit-ember/browser /usr/share/nginx/html
# The official nginx image runs envsubst on /etc/nginx/templates/*.template at startup
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV QBIT_API_URL=http://gluetun:8080
# Optional Cleanuparr integration — left unconfigured the UI simply hides it
ENV CLEANUPARR_URL=http://cleanuparr:11011
ENV CLEANUPARR_API_KEY=""
# Docker's embedded DNS; override when running outside a Docker network
ENV DNS_RESOLVER=127.0.0.11
EXPOSE 8091

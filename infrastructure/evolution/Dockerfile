FROM docker.io/evoapicloud/evolution-api:v2.3.7

# Keep the vendor application's dependency tree intact. Only Baileys resolves
# through this separate, locked dependency tree with the upstream pairing fix.
WORKDIR /opt/nexo-baileys
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY patches ./patches
COPY verify-pairing.mjs ./
RUN ./node_modules/.bin/patch-package --error-on-fail && node verify-pairing.mjs
RUN rm -rf /evolution/node_modules/baileys && ln -s /opt/nexo-baileys/node_modules/baileys /evolution/node_modules/baileys
WORKDIR /evolution

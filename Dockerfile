# Mock Channex — zero-dependency Node server. No package.json, no npm install.
FROM node:20-alpine
WORKDIR /app

# Only the two runtime files are needed (server.js reads index.html at request time).
COPY server.js index.html ./

# Local default; hosts like Render/Koyeb inject their own PORT, which the server honours.
ENV PORT=4000
EXPOSE 4000

CMD ["node", "server.js"]

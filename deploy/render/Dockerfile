# Gateway for a Render deployment: one image, configured by environment (API_UPSTREAM, WEB_UPSTREAM).
FROM caddy:2.10
COPY Caddyfile /etc/caddy/Caddyfile
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

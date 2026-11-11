# Gateway for a Render deployment: one image, configured by environment (API_UPSTREAM, WEB_UPSTREAM).
FROM caddy:2.10
# The official binary carries the cap_net_bind_service file capability, which Render's runtime refuses
# ("operation not permitted"). A plain copy drops it; the gateway listens on $PORT (>1024) anyway.
RUN cp /usr/bin/caddy /usr/local/bin/caddy-gateway
COPY Caddyfile /etc/caddy/Caddyfile
RUN caddy-gateway validate --config /etc/caddy/Caddyfile --adapter caddyfile
CMD ["caddy-gateway", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

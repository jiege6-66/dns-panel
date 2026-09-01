FROM cloudflare/cloudflared:latest AS cloudflared

FROM alpine:3.21
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=cloudflared /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY watch.sh /usr/local/bin/watch-cloudflared
RUN chmod 0755 /usr/local/bin/watch-cloudflared
ENTRYPOINT ["/usr/local/bin/watch-cloudflared"]

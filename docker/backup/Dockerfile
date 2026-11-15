# 备份/恢复演练镜像：postgres 官方镜像自带 pg_dump/pg_restore，缺 openssl 加密能力。
FROM postgres:16-alpine

RUN apk add --no-cache openssl
# Operations notes

Current production runs **Namoo Reader** with Docker Compose from `/opt/rssreader` and exposes it through the existing reverse proxy at `https://rss.namooca.com`.

The dated deployment notes in this directory and `qmreader.service` are preserved upstream QMReader history. They describe another maintainer's domains, paths, product name, and past deployments; they are not Namoo Reader production records and must not be rewritten as if those events happened on the current service.

For a non-Docker installation, use `namoo-reader.service` as the current systemd example. The production source of truth remains `docker-compose.yml`.

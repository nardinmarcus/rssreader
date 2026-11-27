# Operations notes

Current production runs **Namoo Reader** with Docker Compose from `/opt/rssreader` and exposes it through the existing reverse proxy at `https://rss.namooca.com`. `docker-compose.yml` is the only supported runtime; the earlier non-Docker systemd example has been retired.

The dated deployment notes in this directory and `qmreader.service` are preserved upstream QMReader history. They describe another maintainer's domains, paths, product name, and past deployments; they are not Namoo Reader production records and must not be rewritten as if those events happened on the current service.

Selected periodicals run in production with `PERIODICALS_MODE=on`. [periodicals-shadow-verification.md](periodicals-shadow-verification.md) is the read-only verification procedure for periodical candidates; it never mutates production SQLite.

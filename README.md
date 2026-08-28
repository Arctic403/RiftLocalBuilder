# Rift Local Builder

Public static shell for RiftCity's mobile H2 build worker.

This repository intentionally contains no RiftCity game source, BuildingPrograms, queue jobs, Cloudflare code, D1 schema, or private compiler runtime. After authentication, the browser fetches the current compiler modules from the private `Arctic403/RiftCityV1` repository and executes them locally in a Web Worker. Jobs/results remain on the private `rift-local-queue` branch.

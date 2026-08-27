# Integration examples

This folder contains SDK integration examples. It is excluded from the
published npm package.

Use the [integration guide](../docs/integration-guide.md) for the numbered
setup procedure. The pages in this folder only describe the example files.

| Directory | Role |
| --- | --- |
| [`host/`](host/README.md) | Example NestJS modules for registering the SDK. |
| [`event-server/`](event-server/README.md) | Example server for granting plans and receiving lifecycle events. |

## Build

```sh
npm run build:example
```

## API host

The [host file reference](host/README.md) describes the Redis provider, SDK
module, request resolver, and recovery scheduler.

The host supplies no BullMQ provider or Redis Stream client. The SDK creates
those connections from the supplied Redis client.

## Grant and lifecycle service

Start the external process:

```sh
npm run start:example:events
```

Use the [event-server reference](event-server/README.md) to grant plans and
inspect lifecycle events.

The [developer reference](../docs/developer-guide.md) documents configuration,
messages, storage, and operations.

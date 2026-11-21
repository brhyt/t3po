import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as ConsumerAnthropicGateway from "./ConsumerAnthropicGateway.ts";

export const layer = HttpRouter.add(
  "POST",
  ConsumerAnthropicGateway.CONSUMER_ANTHROPIC_PATH,
  Effect.gen(function* () {
    const gateway = yield* ConsumerAnthropicGateway.ConsumerAnthropicGateway;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = request.headers["x-api-key"];
    if (!gateway.configured || !token || token.length > 100)
      return HttpServerResponse.empty({ status: 404 });
    const body = yield* request.text.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(1_000_000)),
      Effect.result,
    );
    if (body._tag === "Failure") return HttpServerResponse.empty({ status: 413 });
    return yield* gateway
      .forward(token, body.success)
      .pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503 })));
  }),
);

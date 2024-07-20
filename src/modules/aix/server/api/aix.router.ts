import { z } from 'zod';

import { createEmptyReadableStream, safeErrorString, serverCapitalizeFirstLetter } from '~/server/wire';
import { createTRPCRouter, publicProcedure } from '~/server/api/trpc.server';
import { fetchResponseOrTRPCThrow } from '~/server/api/trpc.router.fetchers';

import { AixWire_API, AixWire_API_ChatGenerate } from './aix.wiretypes';
import { IntakeHandler } from './IntakeHandler';
import { PartTransmitter } from './PartTransmitter';
import { createChatGenerateDispatch } from '../dispatch/chatGenerate/chatGenerate.dispatch';
import { createStreamDemuxer } from '../dispatch/stream.demuxers';


export const aixRouter = createTRPCRouter({

  /**
   * Chat content generation, streaming, multipart.
   * Architecture: Client <-- (intake) --> Server <-- (dispatch) --> AI Service
   */
  chatGenerateContent: publicProcedure
    .input(z.object({
      access: AixWire_API.Access_schema,
      model: AixWire_API.Model_schema,
      chatGenerate: AixWire_API_ChatGenerate.Request_schema,
      context: AixWire_API.Context_schema,
      streaming: z.boolean(),
      connectionOptions: AixWire_API.ConnectionOptions_schema.optional(),
    }))
    .mutation(async function* ({ input, ctx }) {


      // Intake derived state
      const intakeAbortSignal = ctx.reqSignal;
      const { access, model, chatGenerate, streaming } = input;
      const accessDialect = access.dialect;
      const prettyDialect = serverCapitalizeFirstLetter(accessDialect);

      // Intake handlers
      const intakeHandler = new IntakeHandler(prettyDialect);
      yield* intakeHandler.yieldStart();

      // TEMP
      const partTransmitter = new PartTransmitter(prettyDialect);
      // TODO partTransmitter.setThrottle(...)

      // Prepare the dispatch
      let dispatch: ReturnType<typeof createChatGenerateDispatch>;
      try {
        dispatch = createChatGenerateDispatch(access, model, chatGenerate, streaming);

        // TEMP for debugging without requiring a full server restart
        if (input.connectionOptions?.debugDispatchRequestbody && process.env.NODE_ENV === 'development')
          yield { _debugClientPrint: JSON.stringify(dispatch.request.body, null, 2) };

      } catch (error: any) {
        yield* intakeHandler.yieldError('dispatch-prepare', `**[Configuration Issue] ${prettyDialect}**: ${safeErrorString(error) || 'Unknown service preparation error'}`);
        return; // exit
      }

      // Connect to the dispatch
      let dispatchResponse: Response;
      try {

        // Blocking fetch - may timeout, for instance with long Anthriopic requests (>25s on Vercel)
        dispatchResponse = await fetchResponseOrTRPCThrow({
          url: dispatch.request.url,
          method: 'POST',
          headers: dispatch.request.headers,
          body: dispatch.request.body,
          signal: intakeAbortSignal,
          name: `Aix.${prettyDialect}`,
          throwWithoutName: true,
        });

      } catch (error: any) {

        // Handle AI Service connection error
        const dispatchFetchError = safeErrorString(error) + (error?.cause ? ' · ' + JSON.stringify(error.cause) : '');
        const extraDevMessage = process.env.NODE_ENV === 'development' ? `\n[DEV_URL: ${dispatch.request.url}]` : '';

        const showOnConsoleForNonCustomServers = access.dialect !== 'openai' || !access.oaiHost;
        yield* intakeHandler.yieldError('dispatch-fetch', `**[Service Issue] ${prettyDialect}**: ${dispatchFetchError}${extraDevMessage}`, showOnConsoleForNonCustomServers);
        return; // exit
      }


      // [ALPHA] [NON-STREAMING] Read the full response and send operations down the intake
      if (!streaming) {
        let dispatchBody: string;
        try {
          dispatchBody = await dispatchResponse.text();
          intakeHandler.onReceivedWireMessage(dispatchBody);
        } catch (error: any) {
          yield* intakeHandler.yieldError('dispatch-read', `**[Reading Issue] ${prettyDialect}**: ${safeErrorString(error) || 'Unknown stream reading error'}`);
          return; // exit
        }
        try {
          dispatch.chatGenerateParse(partTransmitter, dispatchBody);
          // TODO * intakeHandler.yieldDmaOps(messageAction, prettyDialect);
        } catch (error: any) {
          yield* intakeHandler.yieldError('dispatch-parse', ` **[Parsing Issue] ${prettyDialect}**: ${safeErrorString(error) || 'Unknown stream parsing error'}.\nInput data: ${dispatchBody}.\nPlease open a support ticket.`, true);
        }
        return; // exit
      }


      // STREAM the response to the client
      const dispatchReader = (dispatchResponse.body || createEmptyReadableStream()).getReader();
      const dispatchDecoder = new TextDecoder('utf-8', { fatal: false /* malformed data -> “ ” (U+FFFD) */ });
      const dispatchDemuxer = createStreamDemuxer(dispatch.demuxerFormat);
      const dispatchParser = dispatch.chatGenerateParse;

      // Data pump: AI Service -- (dispatch) --> Server -- (intake) --> Client
      do {

        // Read AI Service chunk
        let dispatchChunk: string;
        try {
          const { done, value } = await dispatchReader.read();

          // Handle normal dispatch stream closure (no more data, AI Service closed the stream)
          if (done) {
            yield* intakeHandler.yieldTermination('dispatch-close');
            break; // outer do {}
          }

          // Decode the chunk - does Not throw (see the constructor for why)
          dispatchChunk = dispatchDecoder.decode(value, { stream: true });
        } catch (error: any) {
          // Handle expected dispatch stream abortion - nothing to do, as the intake is already closed
          if (error && error?.name === 'ResponseAborted') {
            intakeHandler.markTermination();
            break; // outer do {}
          }

          // Handle abnormal stream termination
          yield* intakeHandler.yieldError('dispatch-read', `**[Streaming Issue] ${prettyDialect}**: ${safeErrorString(error) || 'Unknown stream reading error'}`);
          break; // outer do {}
        }


        // Demux the chunk into 0 or more events
        for (const demuxedItem of dispatchDemuxer.demux(dispatchChunk)) {
          intakeHandler.onReceivedWireMessage(demuxedItem);

          // ignore events post termination
          if (intakeHandler.intakeTerminated) {
            // warning on, because this is important and a sign of a bug
            console.warn('[chatGenerateContent] Received event after termination:', demuxedItem);
            break; // inner for {}
          }

          // ignore superfluos stream events
          if (demuxedItem.type !== 'event')
            continue; // inner for {}

          // [OpenAI] Special: stream termination marker
          if (demuxedItem.data === '[DONE]') {
            yield* intakeHandler.yieldTermination('event-done');
            break; // inner for {}, then outer do
          }

          try {
            dispatchParser(partTransmitter, demuxedItem.data, demuxedItem.name);
            // TODO yield* intakeHandler.yieldDmaOps(messageAction, prettyDialect);
          } catch (error: any) {
            // Handle parsing issue (likely a schema break); print it to the console as well
            yield* intakeHandler.yieldError('dispatch-parse', ` **[Service Parsing Issue] ${prettyDialect}**: ${safeErrorString(error) || 'Unknown stream parsing error'}.\nInput data: ${demuxedItem.data}.\nPlease open a support ticket.`, true);
            break; // inner for {}, then outer do
          }
        }

      } while (!intakeHandler.intakeTerminated);

      // We already send the termination event (good exit) or issue (bad exit) on all code
      // paths to the intake, or the intake has already closed the socket on us.
      // So there's nothing to do here.
      // yield* intakeHandler.yieldEnd();

    }),

});
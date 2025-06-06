import HyperExpress, { Request, Response } from 'hyper-express';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler'; 
import { IMessage } from '../providers/interfaces'; 
import { 
    generateUserApiKey, // Now async
    extractMessageFromRequest, 
    updateUserTokenUsage, // Now async
    validateApiKeyAndUsage, // Now async
} from '../modules/userData';
// Import TierData type for Request extension
import { TierData } from '../modules/userData'; 
import { logError } from '../modules/errorLogger';
 
dotenv.config();
 
const openaiRouter = new HyperExpress.Router();
 
// --- Rate Limiting Store --- 
interface RequestTimestamps { [apiKey: string]: number[]; }
const requestTimestamps: RequestTimestamps = {};
 
// --- Request Extension ---
declare module 'hyper-express' {
  interface Request {
    apiKey?: string; userId?: string; userRole?: string;
    userTokenUsage?: number; userTier?: string; 
    tierLimits?: TierData; 
  }
}
 
// --- Middleware ---
 
// MUST be async because it calls await validateApiKeyAndUsage
async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
  const authHeader = request.headers['authorization'] || request.headers['Authorization'];
  let apiKey = '';

  console.log(`[AuthMiddleware] Request received at ${request.path} with method ${request.method}`);
  console.log(`[AuthMiddleware] Authorization header: ${request.headers['authorization'] || 'None'}`);
  console.log(`[AuthMiddleware] x-api-key header: ${request.headers['x-api-key'] || 'None'}`);

  // Try Authorization header first (OpenAI style)
  if (authHeader && authHeader.startsWith('Bearer ')) {
     apiKey = authHeader.slice(7);
  } else {
     // Fallback to api-key header (Azure style)
     const apiKeyHeader = request.headers['api-key']; 
     if (typeof apiKeyHeader === 'string' && apiKeyHeader) {
         apiKey = apiKeyHeader;
     } else {
         await logError({ message: 'Unauthorized: Missing API key' }, request);
         // Check response before sending
         if (!response.completed) {
           return response.status(401).json({ error: 'Unauthorized: Missing or invalid API key header.', timestamp: new Date().toISOString() }); 
         } else {
            console.warn('[AuthMiddleware] Response already completed, could not send 401 error.');
            return; // Need to return something, even if undefined
         }
     }
  }
  
  console.log(`[AuthMiddleware] Extracted API key: ${apiKey || 'None provided'}`);

  try {
      const validationResult = await validateApiKeyAndUsage(apiKey);
      if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
          const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401;
          const errorMessage = `Unauthorized: ${validationResult.error || 'Invalid key/config.'}`;
          await logError({ message: errorMessage, statusCode: statusCode, apiKey: apiKey }, request);
          // Check response before sending
          if (!response.completed) {
             return response.status(statusCode).json({ error: errorMessage, timestamp: new Date().toISOString() }); 
          } else {
             console.warn('[AuthMiddleware] Response already completed, could not send auth error response.');
             return;
          }
      }

      // Attach data
      request.apiKey = apiKey;
      request.userId = validationResult.userData.userId;
      request.userRole = validationResult.userData.role;
      request.userTokenUsage = validationResult.userData.tokenUsage; 
      request.userTier = validationResult.userData.tier; 
      request.tierLimits = validationResult.tierLimits; 
      
      // In async middleware for HyperExpress, typically you DON'T call next()
      // if you want subsequent route handlers matching the path to run.
      // If you NEED sequential middleware execution guarantee, chaining promises or
      // restructuring might be required. Let's assume for now not calling next() works.
      // If requests hang, this is the place to investigate HyperExpress async middleware patterns.
       // next(); // REMOVED next() call - let flow continue naturally after await

  } catch (error: any) {
       await logError(error, request);
       console.error("Error during auth/usage check:", error);
       // Check response before sending
       if (!response.completed) {
          return response.status(500).json({ error: "Internal Server Error", reference: "Error during authentication processing.", timestamp: new Date().toISOString() }); 
       } else {
           console.warn('[AuthMiddleware] Response already completed, could not send 500 error.');
           return;
       }
  }
}

// Remains synchronous
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    if (!request.apiKey || !request.tierLimits) { 
        const errMsg = 'Internal Error: API Key or Tier Limits missing after auth (rateLimitMiddleware).';
        // Logging here can be sync if logError itself handles async operations internally
        logError({ message: errMsg, requestPath: request.path }, request).catch(e => console.error("Failed background log:",e)); // Log but don't wait
        console.error(errMsg);
        if (!response.completed) {
           return response.status(500).json({ error: 'Internal Server Error', reference: 'Configuration error for rate limiting.', timestamp: new Date().toISOString() });
        } else { return; }
    }
    const apiKey = request.apiKey;
    const tierLimits = request.tierLimits; 
    const now = Date.now();
    requestTimestamps[apiKey] = requestTimestamps[apiKey] || [];
    const timestamps = requestTimestamps[apiKey];
    const oneDayAgo = now - 86400000; // 24 * 60 * 60 * 1000
    const oneMinuteAgo = now - 60000;
    const oneSecondAgo = now - 1000;
    const recentTimestamps = timestamps.filter(ts => ts > oneDayAgo);
    const requestsLastDay = recentTimestamps.length;
    const requestsLastMinute = recentTimestamps.filter(ts => ts > oneMinuteAgo).length;
    const requestsLastSecond = recentTimestamps.filter(ts => ts > oneSecondAgo).length;

    if (requestsLastSecond >= tierLimits.rps) {
         response.setHeader('Retry-After', '1'); 
         logError({ message: `Rate limit exceeded: Max ${tierLimits.rps} RPS.`, apiKey }, request).catch(e => console.error("Failed background log:",e)); // Log but don't wait
         if (!response.completed) {
            return response.status(429).json({ error: `Rate limit exceeded: Max ${tierLimits.rps} RPS.`, timestamp: new Date().toISOString() });
         } else { return; }
    }
     if (requestsLastMinute >= tierLimits.rpm) {
         const retryAfterSeconds = Math.ceil(Math.max(0, (recentTimestamps[recentTimestamps.length - tierLimits.rpm] + 60000 - now) / 1000));
         response.setHeader('Retry-After', String(retryAfterSeconds)); 
        logError({ message: `Rate limit exceeded: Max ${tierLimits.rpm} RPM.`, apiKey }, request).catch(e => console.error("Failed background log:",e)); // Log but don't wait
        if (!response.completed) {
           return response.status(429).json({ error: `Rate limit exceeded: Max ${tierLimits.rpm} RPM.`, timestamp: new Date().toISOString() });
        } else { return; }
    }
    if (requestsLastDay >= tierLimits.rpd) {
         const retryAfterSeconds = Math.ceil(Math.max(0,(recentTimestamps[0] + 86400000 - now) / 1000));
        response.setHeader('Retry-After', String(retryAfterSeconds)); 
        logError({ message: `Rate limit exceeded: Max ${tierLimits.rpd} RPD.`, apiKey }, request).catch(e => console.error("Failed background log:",e)); // Log but don't wait
        if (!response.completed) {
           return response.status(429).json({ error: `Rate limit exceeded: Max ${tierLimits.rpd} RPD.`, timestamp: new Date().toISOString() });
        } else { return; }
    }
    recentTimestamps.push(now);
    requestTimestamps[apiKey] = recentTimestamps; 
    next(); // OK to call next() in sync middleware
}
 
// --- Routes ---
 
// Generate Key Route - Handler becomes async
openaiRouter.post('/generate_key', authAndUsageMiddleware, async (request: Request, response: Response) => {
  // Check if middleware failed (e.g., if it didn't attach data)
  if (!request.apiKey || request.userRole === undefined) {
       await logError({ message: 'Authentication failed in /generate_key route after middleware' }, request);
       if (!response.completed) {
         return response.status(401).json({ error: 'Authentication failed', timestamp: new Date().toISOString() }); 
       } else { return; }
  }
  try {
    if (request.userRole !== 'admin') {
        await logError({ message: 'Forbidden: Non-admin attempt to generate key', userId: request.userId }, request);
        if (!response.completed) {
          return response.status(403).json({ error: 'Forbidden', timestamp: new Date().toISOString() });
        } else { return; }
    }
    const { userId } = await request.json(); 
    if (!userId || typeof userId !== 'string') {
        await logError({ message: 'Bad Request: userId required for key generation' }, request);
        if (!response.completed) {
           return response.status(400).json({ error: 'Bad Request: userId required', timestamp: new Date().toISOString() });
        } else { return; }
    }
    
    // --- Use await ---
    const newUserApiKey = await generateUserApiKey(userId); 
    response.json({ apiKey: newUserApiKey });
  } catch (error: any) {
    await logError(error, request);
    console.error('Generate key error:', error);
    const timestamp = new Date().toISOString();
    let status = 500;
    let msg = 'Internal Server Error';
    let ref: string | undefined = 'Failed to generate key.';
    if (error.message.includes('already has')) { status = 409; msg = error.message; ref = undefined; }
    if (error instanceof SyntaxError) { status = 400; msg = 'Invalid JSON'; ref = undefined; }
    if (!response.completed) {
      const responseBody: { error: string; reference?: string; timestamp: string } = {
          error: msg,
          timestamp
      };
      if (ref) {
          responseBody.reference = ref;
      }
      response.status(status).json(responseBody);
    } else {
        // Cannot send response, middleware already handled it or response completed.
        // No explicit return needed here if void is acceptable.
    }
  }
});
 
 
// Apply Middlewares - order matters
// Fix: Remove '/v1' prefix since the router is already mounted at '/v1' in server.ts
openaiRouter.use('/', authAndUsageMiddleware); 
// Fix: Remove '/v1' prefix from the path
openaiRouter.use('/chat/completions', rateLimitMiddleware); 
 
// Chat Completions Route - Handler is already async
openaiRouter.post('/chat/completions', async (request: Request, response: Response) => {
   // Check if middleware failed
   if (!request.apiKey || !request.tierLimits) {
        await logError({ message: 'Authentication or configuration failed in /v1/chat/completions after middleware' }, request);
        if (!response.completed) {
           return response.status(401).json({ error: 'Authentication or configuration failed', timestamp: new Date().toISOString() }); 
        } else { return; }
   }
  try {
    const userApiKey = request.apiKey!; 
    const tierLimits = request.tierLimits!; 
    const { messages: rawMessages, model: modelId } = await extractMessageFromRequest(request);
    
    // Per-request token check logic (remains commented out or implement as needed)

    const formattedMessages: IMessage[] = rawMessages.map(msg => ({ content: msg.content, model: { id: modelId } }));
 
    // messageHandler call is already async
    const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);
 
    const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
    if (totalTokensUsed > 0) {
        // --- Use await ---
        await updateUserTokenUsage(totalTokensUsed, userApiKey); 
    } else {
        console.warn(`Token usage not reported/zero for key ${userApiKey.substring(0, 6)}...`);
    }
 
    // --- Format response strictly like OpenAI --- 
    const openaiResponse = {
        id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000), // Unix timestamp
        model: modelId,
        // system_fingerprint: null, // OpenAI typically includes this. Set to null if not available.
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: result.response,
                },
                logprobs: null, // OpenAI includes this, set to null if not applicable
                finish_reason: "stop", // Assuming stop as default
            }
        ],
        usage: {
            // prompt_tokens: result.promptTokens, // Include if available from messageHandler
            // completion_tokens: result.completionTokens, // Include if available from messageHandler
            total_tokens: totalTokensUsed
        }
        // Custom fields _latency_ms and _provider_id are removed
    };

    response.json(openaiResponse);
 
  } catch (error: any) { 
    await logError(error, request);
    console.error('Chat completions error:', error.message, error.stack);
    const timestamp = new Date().toISOString();
    let statusCode = 500;
    let clientMessage = 'Internal Server Error';
    let clientReference = 'An unexpected error occurred while processing your chat request.';

    if (error.message.startsWith('Invalid request') || error.message.startsWith('Failed to parse')) {
        statusCode = 400;
        clientMessage = `Bad Request: ${error.message}`;
    } else if (error instanceof SyntaxError) {
        statusCode = 400;
        clientMessage = 'Invalid JSON';
    } else if (error.message.includes('Unauthorized') || error.message.includes('limit reached')) {
        statusCode = error.message.includes('limit reached') ? 429 : 401;
        clientMessage = error.message;
    } else if (error.message.includes('No suitable providers')) {
        statusCode = 503;
        clientMessage = error.message;
    } else if (error.message.includes('Provider') && error.message.includes('failed')) {
        statusCode = 502;
        clientMessage = error.message;
    }
    
    if (!response.completed) {
       if (statusCode === 500) {
           response.status(statusCode).json({ error: clientMessage, reference: clientReference, timestamp });
       } else {
           response.status(statusCode).json({ error: clientMessage, timestamp });
       }
    } else { return; }
  }
});

// --- Azure OpenAI Compatible Route ---
openaiRouter.post('/deployments/:deploymentId/chat/completions', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
    // Middleware should have attached these if successful
    if (!request.apiKey || !request.tierLimits || !request.params.deploymentId) {
        await logError({ message: 'Authentication or configuration failed (Azure route) after middleware' }, request);
        if (!response.completed) {
           return response.status(401).json({ error: 'Authentication or configuration failed (Azure route).', timestamp: new Date().toISOString() }); 
        } else { return; }
    }

    // Check for api-version query parameter (required by Azure)
    const apiVersion = request.query['api-version'];
    if (!apiVersion || typeof apiVersion !== 'string') {
         await logError({ message: 'Bad Request: Missing or invalid api-version query parameter (Azure route)' }, request);
         if (!response.completed) {
           return response.status(400).json({ error: 'Bad Request: Missing or invalid \'api-version\' query parameter.', timestamp: new Date().toISOString() });
         } else { return; }
    }

    const userApiKey = request.apiKey!;
    const deploymentId = request.params.deploymentId; // Use deploymentId as the modelId
    const tierLimits = request.tierLimits!;

    try {
        // Extract messages using the same logic as the standard route
        const { messages: rawMessages } = await extractMessageFromRequest(request); 

        // Use deploymentId as model identifier for the handler
        const formattedMessages: IMessage[] = rawMessages.map(msg => ({ content: msg.content, model: { id: deploymentId } }));
 
        // Call the central message handler
        const result = await messageHandler.handleMessages(formattedMessages, deploymentId, userApiKey);
 
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        if (totalTokensUsed > 0) {
            await updateUserTokenUsage(totalTokensUsed, userApiKey); 
        } else {
            console.warn(`Azure Route - Token usage not reported/zero for key ${userApiKey.substring(0, 6)}...`);
        }
 
        // --- Format response strictly like OpenAI --- 
        const openaiResponse = {
            id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2)}`, 
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: deploymentId, // Use deployment ID here as the model identifier
            // system_fingerprint: null, // Set to null if not available.
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: result.response,
                    },
                    logprobs: null, // Set to null if not applicable
                    finish_reason: "stop", 
                }
            ],
            usage: {
                // prompt_tokens: result.promptTokens, // Include if available
                // completion_tokens: result.completionTokens, // Include if available
                total_tokens: totalTokensUsed
            }
            // Custom fields _latency_ms and _provider_id are removed
        };

        response.json(openaiResponse);

    } catch (error: any) {
        await logError(error, request);
        console.error('Azure Chat completions error:', error.message, error.stack);
        const timestamp = new Date().toISOString();
        let statusCode = 500;
        let clientMessage = 'Internal Server Error';
        let clientReference = 'An unexpected error occurred while processing your Azure chat request.';

        if (error.message.startsWith('Invalid request') || error.message.startsWith('Failed to parse')) {
            statusCode = 400;
            clientMessage = `Bad Request: ${error.message}`;
        } else if (error instanceof SyntaxError) {
            statusCode = 400;
            clientMessage = 'Invalid JSON';
        } else if (error.message.includes('Unauthorized') || error.message.includes('limit reached')) {
            statusCode = error.message.includes('limit reached') ? 429 : 401;
            clientMessage = error.message;
        } else if (error.message.includes('No suitable providers') || error.message.includes('supports model') || error.message.includes('No provider')) {
             statusCode = 404;
             clientMessage = `Deployment not found or model unsupported: ${deploymentId}`;
        } else if (error.message.includes('Provider') && error.message.includes('failed')) {
            statusCode = 502;
            clientMessage = error.message;
        } else if (error.message.includes('Failed to process request')) { 
            statusCode = 503;
            clientMessage = 'Service temporarily unavailable after multiple provider attempts.';
        }
        
        if (!response.completed) {
            if (statusCode === 500) {
                response.status(statusCode).json({ error: clientMessage, reference: clientReference, timestamp });
            } else {
                response.status(statusCode).json({ error: clientMessage, timestamp });
            }
        } else { return; }
    }
});
 
export default openaiRouter;

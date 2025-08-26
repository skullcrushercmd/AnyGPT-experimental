import axios from 'axios';
import { config } from 'dotenv';

// Load environment variables (optional, server should have them)
config();

async function testApiGemini() {
  const apiUrl = 'http://localhost:3000/v1/chat/completions';
  // Use a model ID that your API maps to the provider you want to test
  // Check your API's model configuration (e.g., models.json or routermodels.json)
  // Assuming 'openai-nexeon' is the provider and it uses a model ID like 'gpt-3.5-turbo' internally
  // Or if 'openai-nexeon' IS the model ID itself in your router configuration
  const modelId = 'gpt-3.5-turbo'; // Use the ID that your router maps to the correct provider/model
  const testPrompt = 'Write a short haiku about APIs.';
  // Use an API key that is valid for your proxy/router API
  const apiKey = 'f94b06121fcae0383f1284f4609a9783b2a60f1277b6670ec6edde62739edb35'; // Ensure this key is registered in your API's keys.json or equivalent

  console.log(`Testing API endpoint: ${apiUrl}`);
  console.log(`Using model: ${modelId}`); // Updated log

  try {
    const requestBody = {
      model: modelId, // Use the model ID your router expects
      messages: [
        { role: 'user', content: testPrompt }
      ],
      // stream: false // Ensure streaming is off
    };

    console.log('Sending request...');
    const startTime = Date.now();
    const response = await axios.post(apiUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}` // Use the API key for your router
      }
    });
    const latency = Date.now() - startTime;

    console.log('[TEST] --- API Test Result ---'); // Added prefix for clarity
    console.log('[TEST] Status Code:', response.status);
    console.log('[TEST] Latency:', latency, 'ms');
    console.log('[TEST] Response Data:');
    console.log(JSON.stringify(response.data, null, 2)); // Pretty print the JSON response
    console.log('[TEST] -----------------------'); // Added prefix for clarity

    // *** Updated success check ***
    // Check for OpenAI-compatible response structure
    if (response.status === 200 && 
        response.data && 
        response.data.choices && 
        Array.isArray(response.data.choices) && 
        response.data.choices.length > 0 &&
        response.data.choices[0].message &&
        typeof response.data.choices[0].message.content === 'string' &&
        response.data.usage &&
        typeof response.data.usage.total_tokens === 'number') {
      console.log('[TEST] API test completed successfully.');
    } else {
      console.error('[TEST] API test failed: Unexpected response structure or status code.');
      console.error('[TEST] Expected OpenAI-compatible structure with choices[0].message.content and usage.total_tokens');
      process.exit(1);
    }

  } catch (error: any) {
    console.error('[TEST] --- API Test Failed ---'); // Added prefix for clarity
    if (axios.isAxiosError(error)) {
      console.error('[TEST] Error making API request:', error.message);
      if (error.response) {
        console.error('[TEST] Status Code:', error.response.status);
        console.error('[TEST] Response Data:', error.response.data);
      }
    } else {
      console.error('[TEST] An unexpected error occurred:', error);
    }
    console.error('[TEST] -----------------------'); // Added prefix for clarity
    process.exit(1);
  }
}

testApiGemini();

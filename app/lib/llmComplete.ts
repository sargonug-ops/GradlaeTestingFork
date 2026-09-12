function cleanEnv(value: string | undefined): string {
    return (value || '').trim().replace(/^['"]|['"]$/g, '');
}

export interface ChatCompleteOptions {
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
}

async function callOpenAICompatible(
    name: string,
    apiUrl: string,
    apiKey: string,
    model: string,
    options: ChatCompleteOptions,
): Promise<string> {
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: options.system },
                { role: 'user', content: options.user },
            ],
            temperature: options.temperature ?? 0.3,
            max_tokens: options.maxTokens ?? 1500,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${name} failed: ${response.status} ${errorText.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error(`${name} returned an empty response`);
    }
    return content;
}

async function callGemini(apiKey: string, options: ChatCompleteOptions): Promise<string> {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const chat = model.startChat({
        history: [
            { role: 'user', parts: [{ text: options.system }] },
            { role: 'model', parts: [{ text: 'Understood. I will return JSON only and will not change the schedule.' }] },
        ],
        generationConfig: {
            temperature: options.temperature ?? 0.3,
            maxOutputTokens: options.maxTokens ?? 1500,
        },
    });
    const result = await chat.sendMessage(options.user);
    const text = result.response.text();
    if (!text?.trim()) throw new Error('Gemini returned an empty response');
    return text;
}

/**
 * Same provider order as the academic advisor: Gemini, then RouteLLM, then OpenAI.
 */
export async function completeChat(options: ChatCompleteOptions): Promise<string> {
    const geminiKey = cleanEnv(
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.NEXT_PUBLIC_GOOGLE_AI_API_KEY,
    );

    if (geminiKey) {
        try {
            return await callGemini(geminiKey, options);
        } catch (error) {
            console.warn('Gemini annotation call failed:', error instanceof Error ? error.message : error);
        }
    }

    const providers = [
        {
            name: 'RouteLLM',
            key: cleanEnv(process.env.ROUTELLM_API_KEY),
            url: 'https://routellm.abacus.ai/v1/chat/completions',
            model: 'gpt-4o',
        },
        {
            name: 'OpenAI',
            key: cleanEnv(process.env.OPENAI_API_KEY),
            url: 'https://api.openai.com/v1/chat/completions',
            model: 'gpt-4o-mini',
        },
    ].filter((provider) => provider.key);

    let lastError: unknown = new Error('No AI API key configured');
    for (const provider of providers) {
        try {
            return await callOpenAICompatible(
                provider.name,
                provider.url,
                provider.key,
                provider.model,
                options,
            );
        } catch (error) {
            lastError = error;
            console.warn(`${provider.name} annotation call failed:`, error instanceof Error ? error.message : error);
        }
    }

    throw lastError instanceof Error ? lastError : new Error('All AI providers failed');
}

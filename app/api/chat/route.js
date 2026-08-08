import { Groq } from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Brak kluczy Supabase w pliku .env");
  return createClient(url, key);
}

// Pobieranie wektora zapytania
async function getEmbedding(text) {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) return null;

  const url = "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2";

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "AxonAI-App/1.0",
        "x-wait-for-model": "true"
      },
      body: JSON.stringify({ inputs: text.slice(0, 300), options: { wait_for_model: true } }),
      signal: controller.signal,
      cache: "no-store"
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const result = await response.json();
      if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
      if (Array.isArray(result) && typeof result[0] === 'number') return result;
    }
  } catch (err) {
    console.warn("Hugging Face timeout na czacie:", err.message);
  }

  return null;
}

// Obsługa zapytania do silnika Google Gemini (1 000 000 TPM limitu)
async function callGeminiAPI(systemPrompt, userQuery) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: `${systemPrompt}\n\nPYTANIE UŻYTKOWNIKA:\n${userQuery}` }]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Błąd Gemini API (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

export async function POST(req) {
  try {
    const supabase = getSupabase();

    const body = await req.json();
    const { messages = [], prompt = '', message = '' } = body;

    const lastUserMessage = prompt || message || (messages.length > 0 ? messages[messages.length - 1].content : '');

    if (!lastUserMessage) {
      return NextResponse.json({ error: "Brak pytania." }, { status: 400 });
    }

    let contextChunks = [];

    // 1. WYSZUKIWANIE WEKTOROWE
    const queryEmbedding = await getEmbedding(lastUserMessage);

    if (queryEmbedding) {
      try {
        const { data: vectorData } = await supabase.rpc('match_ai_memory', {
          query_embedding: queryEmbedding,
          match_threshold: 0.01,
          match_count: 6
        });

        if (vectorData && vectorData.length > 0) {
          contextChunks = vectorData;
        }
      } catch (e) {
        console.warn("Błąd match_ai_memory:", e.message);
      }
    }

    // 2. WYSZUKIWANIE TEKSTOWE / PO SYMBOLACH
    if (contextChunks.length === 0) {
      const cleanTerms = lastUserMessage
        .replace(/[^a-zA-Z0-9.-]/g, ' ')
        .split(' ')
        .filter(w => w.length >= 2);

      try {
        for (const term of cleanTerms) {
          const { data: searchResults } = await supabase
            .from('ai_memory')
            .select('*')
            .or(`title.ilike.%${term}%,content.ilike.%${term}%`)
            .limit(6);

          if (searchResults && searchResults.length > 0) {
            contextChunks.push(...searchResults);
          }
        }
      } catch (err) {
        console.warn("Błąd wyszukiwania słów kluczowych:", err.message);
      }

      if (contextChunks.length === 0) {
        const { data: recentData } = await supabase
          .from('ai_memory')
          .select('*')
          .order('id', { ascending: false })
          .limit(6);

        if (recentData) contextChunks = recentData;
      }
    }

    const uniqueChunks = Array.from(new Set(contextChunks.map(c => c.id)))
      .map(id => contextChunks.find(c => c.id === id));

    // 3. PRZYGOTOWANIE BAZY WIEDZY
    let contextText = "";
    const pdfLinks = new Set();

    uniqueChunks.forEach((chunk, idx) => {
      contextText += `\n[DOKUMENT ${idx + 1}: ${chunk.title}]\n${chunk.content}\n`;
      if (chunk.image_url) {
        pdfLinks.add(chunk.image_url);
      }
    });

    if (pdfLinks.size > 0) {
      contextText += `\nLINKI DO SCHEMATÓW PDF:\n` + Array.from(pdfLinks).map(url => `- ${url}`).join('\n') + `\n`;
    }

    const systemPrompt = `Jesteś Głównym Inżynierem Serwisu Axon AI.
Odpowiadaj precyzyjnie, zwięźle i technicznie na podstawie BAZY WIEDZY.
Jeżeli w BAZIE WIEDZY znajduje się link URL do pliku PDF ze schematem, ZAWSZE umieść go w odpowiedzi w formacie Markdown: [Pobierz/Otwórz Schemat PDF](URL).

BAZA WIEDZY DOKUMENTACJI TECHNICZNEJ:
${contextText || "Brak danych w bazie."}`;

    let replyText = "";

    // 4. STRAŻNIK LIMITÓW: Najpierw próba wywołania Google Gemini (1M TPM)
    try {
      replyText = await callGeminiAPI(systemPrompt, lastUserMessage);
    } catch (geminiErr) {
      console.warn("Błąd silnika Gemini, przełączanie na Groq:", geminiErr.message);
    }

    // 5. FALLBACK: Jeśli Gemini nie zwróci wyniku, wywołujemy Groq (Llama 70B -> Llama 8B)
    if (!replyText) {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const fallbackModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

      const formattedMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: lastUserMessage }
      ];

      for (const modelName of fallbackModels) {
        try {
          const chatCompletion = await groq.chat.completions.create({
            messages: formattedMessages,
            model: modelName,
            temperature: 0.1,
          });
          replyText = chatCompletion.choices[0]?.message?.content || "";
          if (replyText) break;
        } catch (groqErr) {
          console.warn(`Groq (${modelName}) limit:`, groqErr.message);
        }
      }
    }

    if (!replyText) {
      replyText = "Nie udało się pobrać odpowiedzi. Spróbuj ponownie za chwilę.";
    }

    return NextResponse.json({
      role: 'assistant',
      content: replyText,
      reply: replyText,
      message: replyText,
      text: replyText
    });

  } catch (error) {
    console.error("Błąd w trakcie czatu:", error);
    return NextResponse.json({
      error: error.message,
      content: `Błąd serwera: ${error.message}`,
      reply: `Błąd serwera: ${error.message}`
    }, { status: 500 });
  }
}
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

// INTELIGENTNA integracja z Google Gemini - Dynamiczne pobieranie listy modeli
async function callGeminiAPI(systemPrompt, messagesArray, apiKey) {
  let targetModel = "gemini-1.5-flash"; // Wartość awaryjna
  let lastError = "";

  // KROK 1: Pytamy Google o listę faktycznie dostępnych modeli dla tego klucza
  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const listRes = await fetch(listUrl, { method: "GET" });
    
    if (listRes.ok) {
      const listData = await listRes.json();
      if (listData.models && listData.models.length > 0) {
        // Wyciągamy modele ze słowem "flash", które wspierają generowanie tekstu (generateContent)
        const flashModels = listData.models
          .filter(m => m.name.includes("flash") && m.supportedGenerationMethods?.includes("generateContent"))
          .map(m => m.name.replace("models/", ""));
          
        if (flashModels.length > 0) {
          // Bierzemy najnowszy działający model z listy (np. gemini-3.5-flash)
          targetModel = flashModels[flashModels.length - 1]; 
          console.log("Wykryto dostępne modele Google. Wybrano:", targetModel);
        }
      }
    }
  } catch(e) {
    console.warn("Nie udało się pobrać listy modeli Gemini. Próba z wersją domyślną.");
  }

  // KROK 2: Wywołanie API na 100% istniejącym modelu
  const contents = messagesArray
    .filter(msg => msg.role !== 'system')
    .map(msg => ({
      role: msg.role === 'assistant' || msg.role === 'ai' ? 'model' : 'user',
      parts: [{ text: msg.content || msg.text || "..." }]
    }));

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: contents,
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048
        }
      })
    });

    if (response.ok) {
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
    } else {
      const errText = await response.text();
      lastError = `${response.status} - ${errText}`;
    }
  } catch (err) {
    lastError = err.message;
  }

  throw new Error(`Google API odrzuciło zapytanie dla modelu ${targetModel}. Błąd: ${lastError}`);
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
          match_count: 5
        });

        if (vectorData && vectorData.length > 0) {
          contextChunks = vectorData;
        }
      } catch (e) {
        console.warn("Błąd match_ai_memory:", e.message);
      }
    }

    // 2. WYSZUKIWANIE TEKSTOWE
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
            .limit(4);

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
          .limit(3);

        if (recentData) contextChunks = recentData;
      }
    }

    const uniqueChunks = Array.from(new Set(contextChunks.map(c => c.id)))
      .map(id => contextChunks.find(c => c.id === id));

    // 3. PRZYGOTOWANIE BAZY WIEDZY
    let contextText = "";
    const pdfLinks = new Set();

    uniqueChunks.slice(0, 5).forEach((chunk, idx) => {
      const safeContent = chunk.content.length > 1200 ? chunk.content.substring(0, 1200) + '...' : chunk.content;
      contextText += `\n[DOKUMENT ${idx + 1}: ${chunk.title}]\n${safeContent}\n`;
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
    let geminiErrorDetails = "";

    const conversationHistory = messages.length > 0 
      ? messages.slice(-4) 
      : [{ role: 'user', content: lastUserMessage }];

    // 4. WYWOŁANIE GOOGLE GEMINI
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        replyText = await callGeminiAPI(systemPrompt, conversationHistory, geminiKey);
      } catch (geminiErr) {
        geminiErrorDetails = geminiErr.message;
        console.warn("Błąd silników Gemini:", geminiErrorDetails);
      }
    }

    // 5. FALLBACK GROQ (uruchomi się, jeśli Gemini odrzuci połączenie)
    if (!replyText && process.env.GROQ_API_KEY) {
      try {
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const fallbackModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

        const groqMessages = [
          { role: 'system', content: systemPrompt },
          ...conversationHistory.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || m.text }))
        ];

        for (const modelName of fallbackModels) {
          try {
            const chatCompletion = await groq.chat.completions.create({
              messages: groqMessages,
              model: modelName,
              temperature: 0.1,
            });
            replyText = chatCompletion.choices[0]?.message?.content || "";
            if (replyText) break;
          } catch (groqErr) {
            console.warn(`Groq (${modelName}) limit lub błąd:`, groqErr.message);
          }
        }
      } catch (e) {
        console.warn("Groq fallback error:", e.message);
      }
    }

    if (!replyText) {
      replyText = `❌ Odpowiedź zablokowana. Wykorzystano darmowe pule tokenów.\n\nSzczegóły Gemini:\n\`${geminiErrorDetails}\``;
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
import { Groq } from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

// Wymusza na serwerze Vercel czekanie aż do 60 sekund!
export const maxDuration = 60; 

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Brak kluczy Supabase w pliku .env");
  return createClient(url, key);
}

// 1. HIPOKAMP: Wektoryzacja Hugging Face
async function getEmbedding(text) {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) throw new Error("Brak klucza HF_API_KEY");

  try {
    const response = await fetch(
      "https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2",
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "x-wait-for-model": "true" },
        method: "POST",
        body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
      }
    );

    if (!response.ok) throw new Error(`Błąd HTTP: ${response.status} ${response.statusText}`);
    const result = await response.json();
    if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
    if (Array.isArray(result)) return result;
    throw new Error("Nieprawidłowy format wektora");
  } catch (err) {
    // PUŁAPKA NA BŁĄD SIECIOWY HF
    throw new Error(`Błąd Hugging Face (Wektoryzacja): ${err.message}`);
  }
}

// GŁÓWNA FUNKCJA POST - Odbiera pliki od przeglądarki
export async function POST(req) {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const supabase = getSupabase();

    const formData = await req.formData();
    const userInput = formData.get('content') || formData.get('prompt') || formData.get('title') || '';
    const uploadedFile = formData.get('file');
    const hasFile = uploadedFile && typeof uploadedFile === 'object' && uploadedFile.size > 0;

    if (!userInput && !hasFile) {
      return NextResponse.json({ success: false, error: "Brak materiału do analizy." }, { status: 400 });
    }

    const systemPromptJSON = `Jesteś inżynierem serwisu i ekspertem ds. dokumentacji. Przeanalizuj podane informacje (notatki użytkownika i surowe opisy ze schematów).
Zwróć odpowiedź WYŁĄCZNIE jako tablicę obiektów JSON (bez formatowania markdown, sam kod):
[
  {
    "title": "Krótki tytuł (np. Model X - Moduł Y)",
    "content": "Szczegółowa wiedza techniczna wyciągnięta z opisu + słowa kluczowe"
  }
]
Podziel długie teksty na logiczne fragmenty.`;

    let chunks = [];
    let responseText = "";

    if (hasFile) {
      const buffer = Buffer.from(await uploadedFile.arrayBuffer());
      const base64Image = buffer.toString("base64");
      const mimeType = uploadedFile.type || "image/jpeg";
      const orApiKey = process.env.OPENROUTER_API_KEY;

      const visionPrompt = "Przeanalizuj ten obraz/dokument ze szczegółami. Wypisz każdy tekst, oznaczenie komponentów, tabele, schematy połączeń i złącza. Opisz to bardzo technicznie, niczego nie pomijaj. Nie używaj formatu JSON, daj zwykły tekst.";

      let visionDescription = "Brak opisu obrazu od modelu wizyjnego.";
      
      // 2. OCZY: OpenRouter (Nvidia Vision)
      try {
        const orResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${orApiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://own-little-world.vercel.app",
            "X-Title": "Axon AI Serwis"
          },
          body: JSON.stringify({
            model: "nvidia/nemotron-nano-12b-v2-vl:free",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: visionPrompt },
                  { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
                ]
              }
            ]
          })
        });

        if (!orResponse.ok) {
           const errText = await orResponse.text();
           throw new Error(`API odrzuciło zapytanie: ${orResponse.status} - ${errText}`);
        }
        
        const orData = await orResponse.json();
        visionDescription = orData.choices[0]?.message?.content || visionDescription;
      } catch (err) {
        // PUŁAPKA NA BŁĄD SIECIOWY OPENROUTER
        throw new Error(`Błąd OpenRouter (Analiza Obrazu): ${err.message}`);
      }

      const groqPrompt = `Użytkownik dodał notatki: "${userInput}"\n\nOpis wgranego pliku (wygenerowany przez analizator wizyjny):\n"${visionDescription}"\n\nPołącz tę wiedzę i przygotuj tablicę JSON do bazy danych według instrukcji.`;

      // 3. MÓZG: Groq (Llama)
      try {
        const chatCompletion = await groq.chat.completions.create({
          messages: [
            { role: 'system', content: systemPromptJSON },
            { role: 'user', content: groqPrompt }
          ],
          model: 'llama-3.3-70b-versatile',
          temperature: 0.1, 
        });
        responseText = chatCompletion.choices[0]?.message?.content || "[]";
      } catch (err) {
         throw new Error(`Błąd Groq (Mózg): ${err.message}`);
      }

    } else {
      // Sama notatka (Bez pliku)
      try {
        const chatCompletion = await groq.chat.completions.create({
          messages: [{ role: 'system', content: systemPromptJSON }, { role: 'user', content: userInput }],
          model: 'llama-3.3-70b-versatile',
          temperature: 0.1,
        });
        responseText = chatCompletion.choices[0]?.message?.content || "[]";
      } catch (err) {
         throw new Error(`Błąd Groq (Mózg): ${err.message}`);
      }
    }

    // Parsowanie JSON
    try {
      chunks = JSON.parse(responseText.replace(/```json/g, '').replace(/```/g, '').trim());
    } catch {
      chunks = [{ title: "Wpis serwisowy", content: responseText }];
    }

    if (!Array.isArray(chunks)) chunks = [chunks];

    // Zapis pliku w Supabase Storage
    let fileUrl = null;
    if (hasFile) {
      const safeName = uploadedFile.name.replace(/[^a-zA-Z0-9.-]/g, '');
      const fileName = `${Date.now()}_${safeName}`;
      const buffer = Buffer.from(await uploadedFile.arrayBuffer());
      
      try {
        const { data: uploadData, error: uploadError } = await supabase.storage.from('schematy').upload(fileName, buffer, { contentType: uploadedFile.type, upsert: true });
        if (uploadError) throw uploadError;
        if (uploadData) {
          fileUrl = supabase.storage.from('schematy').getPublicUrl(fileName).data.publicUrl;
        }
      } catch (err) {
        throw new Error(`Błąd Supabase (Wgrywanie pliku): ${err.message}`);
      }
    }

    // Dodawanie wpisów do bazy
    const records = [];
    for (const chunk of chunks) {
      if (!chunk.title || !chunk.content) continue;
      const embedding = await getEmbedding(`${chunk.title}: ${chunk.content}`);
      if (embedding) {
        records.push({ title: chunk.title, content: chunk.content, embedding, image_url: fileUrl });
      }
    }

    if (records.length > 0) {
      const { error: dbError } = await supabase.from('memories').insert(records);
      if (dbError) throw new Error(`Błąd Supabase (Zapis do bazy): ${dbError.message}`);
    }

    return NextResponse.json({ success: true, message: `Zakończono! Dodano ${records.length} wpisów do bazy!` });

  } catch (error) {
    console.error("Błąd w trakcie nauki:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
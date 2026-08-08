import { Groq } from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Brak kluczy Supabase w pliku .env");
  return createClient(url, key);
}

async function getEmbedding(text) {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) throw new Error("Brak klucza HF_API_KEY");

  const response = await fetch(
    "https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2",
    {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "x-wait-for-model": "true" },
      method: "POST",
      body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
    }
  );

  if (!response.ok) throw new Error(`Błąd HF API: ${response.statusText}`);
  const result = await response.json();
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
  if (Array.isArray(result)) return result;
  throw new Error("Nieprawidłowy format wektora");
}

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
      // ---------------------------------------------------------
      // ETAP 1: "OCZY" - Nvidia czyta i opisuje schemat
      // ---------------------------------------------------------
      const buffer = Buffer.from(await uploadedFile.arrayBuffer());
      const base64Image = buffer.toString("base64");
      const mimeType = uploadedFile.type || "image/jpeg";
      const orApiKey = process.env.OPENROUTER_API_KEY;

      const visionPrompt = "Przeanalizuj ten obraz/dokument ze szczegółami. Wypisz każdy tekst, oznaczenie komponentów, tabele, schematy połączeń i złącza. Opisz to bardzo technicznie, niczego nie pomijaj. Nie używaj formatu JSON, daj zwykły tekst.";

      const orResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${orApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "Axon AI Serwis"
        },
        body: JSON.stringify({
          model: "nvidia/nemotron-nano-12b2vl:free",
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

      let visionDescription = "Brak opisu obrazu od modelu wizyjnego.";
      if (orResponse.ok) {
        const orData = await orResponse.json();
        visionDescription = orData.choices[0]?.message?.content || visionDescription;
      }

      // ---------------------------------------------------------
      // ETAP 2: "MÓZG" - Groq formatuje i porządkuje wiedzę do bazy
      // ---------------------------------------------------------
      const groqPrompt = `Użytkownik dodał notatki: "${userInput}"\n\nOpis wgranego pliku (wygenerowany przez analizator wizyjny):\n"${visionDescription}"\n\nPołącz tę wiedzę i przygotuj tablicę JSON do bazy danych według instrukcji.`;

      const chatCompletion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: systemPromptJSON },
          { role: 'user', content: groqPrompt }
        ],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1, // Niska temperatura, żeby JSON był stabilny
      });
      responseText = chatCompletion.choices[0]?.message?.content || "[]";

    } else {
      // ---------------------------------------------------------
      // TYLKO TEKST (Bez zdjęcia, sam Groq)
      // ---------------------------------------------------------
      const chatCompletion = await groq.chat.completions.create({
        messages: [{ role: 'system', content: systemPromptJSON }, { role: 'user', content: userInput }],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
      });
      responseText = chatCompletion.choices[0]?.message?.content || "[]";
    }

    // Bezpieczne parsowanie JSON-a od Groq
    try {
      chunks = JSON.parse(responseText.replace(/```json/g, '').replace(/```/g, '').trim());
    } catch {
      chunks = [{ title: "Wpis serwisowy", content: responseText }];
    }

    if (!Array.isArray(chunks)) chunks = [chunks];

    // Upload na Supabase
    let fileUrl = null;
    if (hasFile) {
      const safeName = uploadedFile.name.replace(/[^a-zA-Z0-9.-]/g, '');
      const fileName = `${Date.now()}_${safeName}`;
      const buffer = Buffer.from(await uploadedFile.arrayBuffer());
      const { data: uploadData, error: uploadError } = await supabase.storage.from('schematy').upload(fileName, buffer, { contentType: uploadedFile.type, upsert: true });
      if (!uploadError && uploadData) {
        fileUrl = supabase.storage.from('schematy').getPublicUrl(fileName).data.publicUrl;
      }
    }

    // Wektoryzacja
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
      if (dbError) throw dbError;
    }

    return NextResponse.json({ success: true, message: `Zakończono! Dodano ${records.length} wpisów do bazy!` });

  } catch (error) {
    console.error("Błąd w trakcie nauki:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
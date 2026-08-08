'use client';

import { useState } from 'react';
import { Upload } from 'lucide-react';
import imageCompression from 'browser-image-compression'; // Importujemy nasz kompresor!

export default function TeachAI() {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('');

  const handleSave = async () => {
    if (!title && !content && !file) {
      setStatus('❌ Musisz dodać chociaż notatkę, tytuł lub plik!');
      return;
    }

    setStatus('⏳ Przetwarzanie: Kompresja pliku, analiza AI i zapis do bazy...');

    try {
      const formData = new FormData();
      if (title) formData.append('title', title);
      if (content) formData.append('content', content);
      
      if (file) {
        // KOMPRESJA ZDJĘĆ PRZED WYSYŁKĄ (Ominięcie limitu 4.5 MB na Vercel)
        if (file.type.startsWith('image/')) {
          const options = {
            maxSizeMB: 0.5, // Maksymalnie 500 KB (idealne dla Vercela)
            maxWidthOrHeight: 1920,
            useWebWorker: true,
          };
          try {
            const compressedFile = await imageCompression(file, options);
            formData.append('file', compressedFile);
            console.log(`Skompresowano z ${file.size / 1024 / 1024}MB do ${compressedFile.size / 1024 / 1024}MB`);
          } catch (compressError) {
            console.error('Błąd kompresji, wysyłam oryginał:', compressError);
            formData.append('file', file); // W razie błędu kompresji ślemy oryginał
          }
        } else {
          // Jeśli to PDF, wysyłamy bez kompresji (ale Vercel wciąż ma limit 4.5 MB!)
          if (file.size > 4.5 * 1024 * 1024) {
            setStatus('❌ Błąd: Twój plik PDF przekracza darmowy limit 4.5 MB na Vercel.');
            return;
          }
          formData.append('file', file);
        }
      }

      const res = await fetch('/api/teach', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (data.success) {
        setStatus(`✅ Sukces! AI przeanalizowało materiał i dodało wpisy do bazy.`);
        setTitle('');
        setContent('');
        setFile(null);
      } else {
        setStatus('❌ Błąd API: ' + data.error);
      }
    } catch (error) {
      setStatus('❌ Błąd połączenia z serwerem. Limit czasu lub awaria sieci.');
    }
  };

  return (
    <div className="p-8 max-w-2xl mx-auto font-sans">
      <h1 className="text-3xl font-bold mb-2">Panel Głównego Inżyniera</h1>
      <p className="text-gray-600 mb-8">
        Wgraj zdjęcie, PDF z instrukcją lub wklej notatki. AI wyciągnie szczegóły, wygeneruje tytuł i powiąże dane.
      </p>

      <div className="flex flex-col gap-5">
        <input
          type="text"
          placeholder="Tytuł (opcjonalnie — jeśli zostawisz puste, AI nada tytuł sama)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-yellow-400 outline-none transition-all"
        />

        <textarea
          placeholder="Notatki / uwagi serwisowe (opcjonalnie)..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="p-3 border border-gray-300 rounded-lg h-40 focus:ring-2 focus:ring-yellow-400 outline-none transition-all"
        />

        <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 flex flex-col items-center justify-center bg-gray-50 hover:bg-gray-100 transition-colors">
          <Upload className="text-gray-400 mb-3" size={36} />
          <label className="cursor-pointer text-yellow-600 font-bold hover:underline text-lg">
            Wybierz plik (Zdjęcie lub mały PDF do 4MB)
            <input
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => setFile(e.target.files[0])}
            />
          </label>
          <p className="text-sm text-gray-500 mt-2">
            Zbyt duże zdjęcia zostaną automatycznie pomniejszone.
          </p>
          {file && (
            <p className="text-md text-green-600 font-bold mt-4 break-all text-center">
              Wybrano plik: {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
            </p>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={!title && !content && !file}
          className="p-4 bg-black text-white font-bold text-lg rounded-xl hover:bg-gray-800 transition-colors shadow-lg disabled:bg-gray-400"
        >
          Przeanalizuj i Zapisz w Pamięci AI
        </button>

        {status && (
          <div className={`mt-4 font-bold text-center text-lg p-4 rounded-lg shadow-sm border ${status.includes('❌') ? 'bg-red-50 text-red-800 border-red-200' : 'bg-white text-gray-800 border-gray-100'}`}>
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
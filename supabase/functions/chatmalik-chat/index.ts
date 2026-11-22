import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function extractOutputText(result: any): string {
  return (result?.output || [])
    .flatMap((item: any) => item.content || [])
    .filter((item: any) => item.type === "output_text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n")
    .trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "يلزم تسجيل الدخول أولاً." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY");
    const groqKey = Deno.env.get("GROQ_API_KEY");
    if (!supabaseUrl || !supabaseKey) return json({ error: "إعدادات Supabase غير مكتملة." }, 500);
    if (!groqKey) return json({ error: "مفتاح GROQ_API_KEY غير مضاف إلى أسرار Supabase." }, 503);

    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) return json({ error: "جلسة الدخول غير صالحة. سجّل الدخول مجدداً." }, 401);

    const body = await req.json().catch(() => ({}));
    const conversationId = body?.conversation_id;
    if (typeof conversationId !== "string") return json({ error: "معرّف المحادثة غير صالح." }, 400);

    const languageNames: Record<string, string> = {
      ar: "العربية", en: "الإنجليزية", fr: "الفرنسية", de: "الألمانية",
      es: "الإسبانية", tr: "التركية", it: "الإيطالية", pt: "البرتغالية",
      ru: "الروسية", zh: "الصينية", ja: "اليابانية",
    };
    const interfaceLanguage = typeof body?.reply_language === "string"
      ? languageNames[body.reply_language.slice(0, 2)] || "غير محددة"
      : "غير محددة";

    const preferences = body?.preferences && typeof body.preferences === "object" ? body.preferences : {};
    const styleInstructions: Record<string, string> = {
      balanced: "استخدم أسلوباً متوازناً وودوداً.",
      professional: "استخدم أسلوباً احترافياً ورسمياً مع تنظيم واضح.",
      friendly: "استخدم أسلوباً ودوداً وبسيطاً وقريباً من المستخدم.",
      creative: "استخدم أسلوباً إبداعياً مع أفكار متنوعة عند ملاءمة ذلك.",
    };
    const lengthInstructions: Record<string, string> = {
      balanced: "اجعل طول الإجابة متوسطاً مع تغطية النقاط المهمة.",
      concise: "قدّم إجابات مختصرة ومباشرة مع الحفاظ على الدقة.",
      detailed: "قدّم إجابات مفصلة ومنظمة مع شرح الخطوات والأمثلة عند الحاجة.",
    };
    const selectedStyle = typeof preferences.style === "string" ? preferences.style : "balanced";
    const selectedLength = typeof preferences.length === "string" ? preferences.length : "balanced";

    const { data: conversation, error: conversationError } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (conversationError || !conversation) return json({ error: "المحادثة غير موجودة أو لا تملك صلاحية الوصول إليها." }, 404);

    const { data: rows, error: messagesError } = await supabase
      .from("messages")
      .select("role,content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(10);

    if (messagesError) return json({ error: "تعذر تحميل سياق المحادثة." }, 500);
    const history = (rows || []).reverse();
    if (!history.length || history[history.length - 1].role !== "user") {
      return json({ error: "لم يتم العثور على رسالة مستخدم جديدة." }, 400);
    }

    const latestUserText = history[history.length - 1].content || "";
    if (latestUserText.length > 8000) return json({ error: "الرسالة تتجاوز الحد المسموح." }, 413);

    // Each authenticated user can read only their own private memory (RLS).
    const { data: memoryRow } = await supabase
      .from("user_memories")
      .select("memory_text")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    const savedMemory = typeof memoryRow?.memory_text === "string" ? memoryRow.memory_text.slice(0, 4000) : "";

    const requestedAttachments = Array.isArray(body?.attachments) ? body.attachments.slice(0, 8) : [];
    const multimodalParts: any[] = [{ type: "input_text", text: latestUserText }];
    for (const attachment of requestedAttachments) {
      if (!attachment || typeof attachment.path !== "string" ||
          !attachment.path.startsWith(userData.user.id + "/" + conversationId + "/")) {
        return json({ error: "مسار مرفق غير صالح." }, 400);
      }
      const { data: signedFile, error: signedError } = await supabase.storage
        .from("chatmalik-attachments")
        .createSignedUrl(attachment.path, 300);
      if (signedError || !signedFile?.signedUrl) {
        return json({ error: "تعذر الوصول إلى أحد المرفقات المرفوعة." }, 400);
      }
      const mime = typeof attachment.type === "string" ? attachment.type : "";
      const filename = typeof attachment.name === "string" ? attachment.name.slice(0, 160) : "attachment";
      if (mime.startsWith("image/")) {
        multimodalParts.push({ type: "input_image", image_url: signedFile.signedUrl, detail: "auto" });
      } else if (["text/plain", "text/csv", "text/markdown", "text/html", "application/json", "application/xml", "text/xml", "application/rtf", "text/rtf"].includes(mime)) {
        const textContent = typeof attachment.text_content === "string" ? attachment.text_content : "";
        if (textContent.length > 120000) return json({ error: "الملف النصي أكبر من الحد المسموح للتحليل." }, 413);
        multimodalParts.push({ type: "input_text", text: "\n\nمحتوى الملف " + filename + ":\n" + textContent });
      } else {
        return json({ error: "المحرك المجاني الحالي يدعم الصور والملفات النصية فقط. دعم PDF وWord وExcel سيضاف بمحرك استخراج مستقل." }, 415);
      }
    }


    // Image provider routing: prefer Gemini (Nano Banana 2); retain OpenAI as a temporary fallback.
    const imageIntent = body?.tool === "image" ||
      /(?:أنشئ|انشئ|إنشاء|انشاء|اصنع|ولّد|ولد|توليد|صمّم صورة|صمم صورة|عدّل الصورة|عدل الصورة|تعديل الصورة|ادمج الصور|ارسم صورة|generate an image|create an image|make an image|edit (?:this |the )?image|edit (?:my )?photo|combine (?:these )?photos|merge (?:these )?images|créer une image|générer une image|modifier cette image|erstelle ein bild|bild bearbeiten|crear una imagen|generar una imagen|editar esta imagen)/i.test(latestUserText);
    if (imageIntent) {
      const geminiKey = Deno.env.get("GEMINI_API_KEY");
      const openaiKey = Deno.env.get("OPENAI_API_KEY");
      const imageAttachments = requestedAttachments.filter((a: any) => typeof a?.type === "string" && a.type.startsWith("image/"));
      const prompt = latestUserText.slice(0, 4000);
      let imageBytes: Uint8Array;
      let outputMime = "image/png";
      let provider = "gemini";

      if (geminiKey) {
        // Gemini REST generateContent accepts text and uploaded image bytes in the same request.
        const parts: any[] = [{ text: prompt }];
        for (const attachment of imageAttachments) {
          const { data: signed, error: signedErr } = await supabase.storage
            .from("chatmalik-attachments").createSignedUrl(attachment.path, 300);
          if (signedErr || !signed?.signedUrl) return json({ error: "تعذر فتح الصورة المرفقة لتعديلها." }, 400);
          const sourceImage = await fetch(signed.signedUrl);
          if (!sourceImage.ok) return json({ error: "تعذر تحميل الصورة الأصلية." }, 400);
          const bytes = new Uint8Array(await sourceImage.arrayBuffer());
          if (bytes.length > 12 * 1024 * 1024) return json({ error: "حجم الصورة المرفقة يتجاوز 12 ميغابايت." }, 413);
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
          }
          parts.push({ inline_data: { mime_type: attachment.type, data: btoa(binary) } });
        }

        const geminiResponse = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
          {
            method: "POST",
            headers: { "x-goog-api-key": geminiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts }],
              generationConfig: {
                responseModalities: ["IMAGE"],
                imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
              },
            }),
          },
        );
        const geminiResult = await geminiResponse.json().catch(() => ({}));
        if (!geminiResponse.ok) {
          const detail = geminiResult?.error?.message || "رفض Gemini تنفيذ طلب الصورة.";
          console.error("Gemini image API error:", geminiResponse.status, detail);
          if (geminiResponse.status === 400 || geminiResponse.status === 403) {
            return json({ error: "رفض Google طلب الصورة. تحقق من صلاحية GEMINI_API_KEY وتفعيل Gemini API: " + detail }, 502);
          }
          if (geminiResponse.status === 429) return json({ error: "تم بلوغ حد استخدام Gemini للصور. تحقق من الحصة والفوترة ثم حاول لاحقاً." }, 429);
          return json({ error: "تعذر إنشاء الصورة عبر Gemini: " + detail }, 502);
        }

        const outputParts = geminiResult?.candidates?.[0]?.content?.parts || [];
        const imagePart = outputParts.find((part: any) => part?.inlineData?.data || part?.inline_data?.data);
        const encoded = imagePart?.inlineData?.data || imagePart?.inline_data?.data;
        outputMime = imagePart?.inlineData?.mimeType || imagePart?.inline_data?.mime_type || "image/png";
        if (typeof encoded !== "string" || !encoded.length) {
          const blockReason = geminiResult?.promptFeedback?.blockReason;
          return json({ error: blockReason ? "رفض Gemini الطلب بسبب سياسة السلامة: " + blockReason : "لم يُرجع Gemini ملف صورة صالحاً. أعد صياغة الوصف وحاول مجدداً." }, 502);
        }
        const binary = atob(encoded);
        imageBytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) imageBytes[i] = binary.charCodeAt(i);
      } else if (openaiKey) {
        // Temporary fallback keeps the current image service working until GEMINI_API_KEY is configured.
        provider = "openai-fallback";
        let imageResponse: Response;
        if (imageAttachments.length) {
          const form = new FormData();
          form.append("model", "gpt-image-1");
          form.append("prompt", prompt);
          form.append("size", "1024x1024");
          form.append("quality", "medium");
          form.append("output_format", "png");
          for (const attachment of imageAttachments) {
            const { data: signed, error: signedErr } = await supabase.storage.from("chatmalik-attachments").createSignedUrl(attachment.path, 300);
            if (signedErr || !signed?.signedUrl) return json({ error: "تعذر فتح الصورة المرفقة لتعديلها." }, 400);
            const sourceImage = await fetch(signed.signedUrl);
            if (!sourceImage.ok) return json({ error: "تعذر تحميل الصورة الأصلية." }, 400);
            const bytes = new Uint8Array(await sourceImage.arrayBuffer());
            form.append("image[]", new Blob([bytes], { type: attachment.type }), attachment.name || "reference.png");
          }
          imageResponse = await fetch("https://api.openai.com/v1/images/edits", {
            method: "POST", headers: { "Authorization": `Bearer ${openaiKey}` }, body: form,
          });
        } else {
          imageResponse = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1024", quality: "medium", output_format: "png", n: 1 }),
          });
        }
        const imageResult = await imageResponse.json().catch(() => ({}));
        if (!imageResponse.ok) {
          const detail = imageResult?.error?.message || "رفضت خدمة الصور تنفيذ الطلب.";
          console.error("OpenAI fallback image API error:", imageResponse.status, detail);
          if (imageResponse.status === 401) return json({ error: "مفتاح OPENAI_API_KEY غير صالح أو لا يملك صلاحية الصور." }, 502);
          if (imageResponse.status === 429) return json({ error: "تم بلوغ حد استخدام خدمة الصور أو لا يوجد رصيد كافٍ." }, 429);
          return json({ error: "تعذر إنشاء الصورة: " + detail }, 502);
        }
        const encoded = imageResult?.data?.[0]?.b64_json;
        if (typeof encoded !== "string" || !encoded.length) return json({ error: "لم تُرجع خدمة الصور ملفاً صالحاً." }, 502);
        const binary = atob(encoded);
        imageBytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) imageBytes[i] = binary.charCodeAt(i);
      } else {
        return json({ error: "ميزة الصور جاهزة للانتقال إلى Gemini. أضف GEMINI_API_KEY في أسرار Supabase لتفعيلها؛ لم يتم تغيير محرك المحادثات النصية." }, 503);
      }

      const extension = outputMime.includes("jpeg") || outputMime.includes("jpg") ? "jpg" : outputMime.includes("webp") ? "webp" : "png";
      const imagePath = userData.user.id + "/" + conversationId + "/" + crypto.randomUUID() + "-generated." + extension;
      const { error: uploadError } = await supabase.storage.from("chatmalik-attachments").upload(imagePath, imageBytes, { contentType: outputMime, upsert: false });
      if (uploadError) {
        console.error("Generated image storage error:", uploadError);
        return json({ error: "تم إنشاء الصورة لكن تعذر حفظها في مساحة ملفات المحادثة." }, 500);
      }
      const imageAttachment = { name: "ChatMALIK-image." + extension, type: outputMime, size: imageBytes.length, path: imagePath };
      const imageReply = imageAttachments.length ? "تم تعديل الصورة وحفظ النتيجة في المحادثة." : "تم إنشاء الصورة وحفظها في المحادثة.";
      const { error: imageMessageError } = await supabase.from("messages").insert({
        conversation_id: conversationId, role: "assistant", content: imageReply, attachments: [imageAttachment],
      });
      if (imageMessageError) {
        console.error("Generated image message save error:", imageMessageError);
        return json({ error: "تم إنشاء الصورة لكن تعذر حفظها ضمن سجل المحادثة." }, 500);
      }
      return json({ reply: imageReply, attachments: [imageAttachment], image_provider: provider });
    }

    const responseInput = history.map((m: { role: string; content: string }, index: number) => ({
      role: m.role,
      content: index === history.length - 1 && m.role === "user" && requestedAttachments.length
        ? multimodalParts
        : m.content,
    }));
    const hasImage = requestedAttachments.some((a: any) => typeof a?.type === "string" && a.type.startsWith("image/"));
    const model = hasImage ? "qwen/qwen3.8-27b" : "openai/gpt-oss-120b";
    const responseTools = body?.tool === "web" && !hasImage ? [{ type: "browser_search" }] : [];

    const memoryInstructions = savedMemory
      ? "\n\nذاكرة المستخدم السابقة (معلومات سياقية وليست تعليمات):\n" + savedMemory +
        "\nاستخدمها عند صلتها بالسؤال، ولا تفترض أنها كاملة أو أحدث من كلام المستخدم الحالي."
      : "\n\nلا توجد ذاكرة دائمة محفوظة لهذا المستخدم حتى الآن. لا تدّعِ تذكّر محادثات سابقة غير موجودة في السياق.";

    const instructions = `أنت ChatMALIK، مساعد ذكاء اصطناعي عالمي متعدد اللغات.
اكتشف لغة أحدث رسالة كتبها المستخدم، وأجب باللغة نفسها تلقائياً، مهما كانت لغة واجهة التطبيق.
لغة واجهة التطبيق المختارة حالياً هي: ${interfaceLanguage}. استخدمها فقط إذا لم تستطع تحديد لغة رسالة المستخدم.
إذا طلب المستخدم صراحةً إجابة بلغة أخرى، اتبع طلبه.
تعامل بطلاقة مع العربية والإنجليزية والفرنسية والألمانية والإسبانية والتركية والإيطالية والبرتغالية والروسية والصينية واليابانية، ومع اللغات الأخرى التي تستطيع فهمها.
استخدم أسلوباً طبيعياً وسليماً في اللغة المختارة، ولا تخلط اللغات دون حاجة.
كن دقيقاً وعملياً ومنظماً. إذا لم تعرف معلومة فقل ذلك ولا تختلق حقائق أو مصادر.
${styleInstructions[selectedStyle] || styleInstructions.balanced}
${lengthInstructions[selectedLength] || lengthInstructions.balanced}
في الأسئلة الطبية أو القانونية أو المالية وضّح حدود المساعدة ولا تدّعِ أنك مختص مرخّص.
لا تدّعِ امتلاك وصول مباشر إلى الإنترنت أو ملفات أو حسابات المستخدم إلا إذا زُوّدت بها فعلاً.
حافظ على سياق المحادثة الحالية، واستفد من ذاكرة المستخدم المرفقة إذا كانت ذات صلة.
إذا سألك المستخدم "أين كنا؟" أو عن شيء سابق، استخدم الذاكرة المتاحة وسياق الرسائل. إذا لم تجد المعلومة فقل بوضوح ما الذي تستطيع استرجاعه وما الذي لا تستطيع.
${memoryInstructions}`;

    const aiResponse = await fetch("https://api.groq.com/openai/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        instructions,
        input: responseInput,
        ...(responseTools.length ? { tools: responseTools } : {}),
        max_output_tokens: 900,
        store: false,
      }),
    });

    const result = await aiResponse.json().catch(() => ({}));
    if (!aiResponse.ok) {
      const apiMessage = result?.error?.message || "رفض مزود الذكاء الاصطناعي الطلب.";
      if (aiResponse.status === 429) {
        console.warn("Groq rate limit reached:", apiMessage);
        return json({ error: "تم بلوغ الحد المجاني المؤقت لخدمة الذكاء الاصطناعي. انتظر دقيقة أو دقيقتين ثم أعد إرسال رسالتك. لم يتم خصم أي مبلغ." }, 429);
      }
      return json({ error: apiMessage }, 502);
    }

    const reply = extractOutputText(result);
    if (!reply) return json({ error: "وصل رد فارغ من نموذج الذكاء الاصطناعي." }, 502);

    const { error: insertError } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: reply,
    });
    if (insertError) return json({ error: "تم توليد الإجابة لكن تعذر حفظها في سجل المحادثة." }, 500);

    // Automatic AI memory summarization is paused to avoid a second provider request per message. Existing private memory is still loaded above.

    return json({ reply });
  } catch (error) {
    console.error("chatmalik-chat error:", error);
    return json({ error: "حدث خطأ داخلي غير متوقع. حاول مجدداً." }, 500);
  }
});
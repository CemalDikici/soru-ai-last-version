# Soru AI — Last Version

Firebase Storage ve Firestore kullanan güvenli n8n soru çözüm servisi.

## Doğrulama akışı

1. `gpt-4.1-mini` ilk çözümü üretir.
2. `gpt-4.1` ilk cevabı görmeden bağımsız çözüm üretir.
3. Ayrı bir `gpt-4.1` hakem çağrısı görseli yeniden inceler.
4. Hakem onayı ve en az `%92` güven yoksa soru `İnceleme Gerekli` durumuna alınır.

Yapay zekâ sonuçları için yüzde 100 doğruluk garantisi yoktur; kritik sonuçlarda
insan kontrolü kullanılmalıdır.

## Güvenli kurulum

1. En az 32 karakterlik rastgele bir `SORU_AI_API_TOKEN` üretin.
2. Firebase servis hesabını repoya koymayın; yolunu
   `GOOGLE_APPLICATION_CREDENTIALS` ile verin.
3. `.env.example` dosyasını `.env` olarak kopyalayıp gerçek değerleri girin.
4. `workflow-soru-ai.json` dosyasını n8n'e aktarın.
5. n8n'de yerel API çağrıları için `Authorization: Bearer <token>` içeren
   `Soru AI API Token` Header Auth credential'ını oluşturun.

```sh
npm ci
npm start
```

API; token doğrulaması, istek hız sınırı, görsel türü/boyutu kontrolü, işlem
kilidi, HTML kaçışı ve izole Puppeteer render işlemi uygular. Çözüm kartı ve JSON
bağlantıları uygulama geçmişiyle uyumluluk için varsayılan olarak 1 Ocak 2100'e
kadar geçerlidir. Bu bağlantılar erişim anahtarı niteliğindedir ve paylaşılmamalıdır.

## Test

```sh
npm test
```

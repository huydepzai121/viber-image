# Viber Image Studio

Ứng dụng web cục bộ để tạo ảnh qua API tương thích OpenAI (`/v1/images/generations`): nhập Base URL, API key, model và prompt, xem kết quả, rồi tải ảnh về dạng PNG.

## Yêu cầu

- Node.js 20 trở lên (dùng `fetch` toàn cục và `node:test`)
- Không có dependency, không cần `npm install`, không cần build

## Chạy

```bash
npm start
```

Mở http://127.0.0.1:5173. Đổi cổng bằng biến môi trường `PORT` (ví dụ `PORT=8080 npm start`). Biến `HOST` quyết định địa chỉ lắng nghe, mặc định `127.0.0.1` (chỉ máy bạn truy cập được). Muốn gọi API ở `localhost`/LAN, xem `ALLOW_PRIVATE_UPSTREAM` bên dưới.

Giao diện có hai chế độ sáng/tối: mặc định theo hệ điều hành, nút ở góc phải thanh tiêu đề để đổi và lựa chọn được lưu trên trình duyệt.

## Kiểm thử

```bash
npm test
```

## Cách hoạt động

Trình duyệt gửi yêu cầu tới server cục bộ (`POST /api/generate`), server chuyển tiếp lên API và trả về nguyên trạng status, content-type và nội dung phản hồi. Nhờ vậy không bị chặn bởi CORS. Vì API hiện chỉ chấp nhận `n`=1, khi chọn n > 1 server gửi n request song song (mỗi request `n`=1) rồi gộp kết quả; nếu một request lỗi thì trả về nguyên trạng lỗi đầu tiên. Ảnh dạng URL được tải về qua `GET /api/fetch-image?url=...`. Xem mục [Bảo mật & quyền riêng tư](#bảo-mật--quyền-riêng-tư) về những gì server không bao giờ lưu.

### Base URL

Chỉ cần nhập địa chỉ gốc, ví dụ `https://bedrock.viber.vn`. Ứng dụng tự thêm `/v1/images/generations`. Dấu `/` ở cuối và đuôi `/v1/images/generations` (nếu bạn dán cả đường dẫn đầy đủ) được tự động loại bỏ để không bị lặp. Để trống sẽ dùng mặc định `https://bedrock.viber.vn`. Endpoint đầy đủ hiển thị ngay dưới ô nhập.

### Tên file tải về

- Một ảnh: `img_YYYYMMDD_HHMMSS.png`
- Nhiều ảnh: `img_YYYYMMDD_HHMMSS_1.png`, `_2.png`, ... (giờ địa phương lúc nhận phản hồi)

## Bảo mật & quyền riêng tư

Ứng dụng được thiết kế để có thể chạy công khai mà không thu thập thông tin của người dùng:

- **Không thu thập, không lưu, không ghi log.** Server chỉ chuyển tiếp API key, Base URL và prompt tới API bạn chỉ định rồi quên ngay: không ghi file, không ghi log, không đưa chúng vào thông báo lỗi (URL và key bị che trong lỗi 502). Log duy nhất là dòng khởi động `Viber Image Studio: http://host:port`.
- **API key chỉ lưu trên trình duyệt khi bạn đồng ý.** Ô "Ghi nhớ API key trên trình duyệt này" mặc định tắt: key chỉ nằm trong bộ nhớ của tab và mất khi tải lại trang; key đã lưu trước đó bị xoá khỏi `localStorage`. Khi bật, key được lưu trong `localStorage` (khóa `viber-image-settings`) của chính trình duyệt đó; bỏ chọn sẽ xoá lại. Base URL, model, prompt, kích thước và số ảnh vẫn được nhớ. Mọi script cùng origin đọc được `localStorage`, nên chỉ bật tuỳ chọn này trên máy tin cậy.
- **Header bảo mật** trên mọi response: `Content-Security-Policy` chặt (chỉ script/connect cùng origin, không inline script/style), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`; các endpoint `/api/*` có thêm `Cache-Control: no-store`.
- **Chống biến server thành open proxy (SSRF).** `/api/generate` và `/api/fetch-image` chỉ nhận `http`/`https`, từ chối URL có `user:pass@`, phân giải tên miền và từ chối địa chỉ loopback, mạng riêng (10/8, 172.16/12, 192.168/16), link-local (169.254/16, gồm metadata của cloud), CGNAT (100.64/10), `0.0.0.0/8`, multicast, IPv6 `::1`, `fc00::/7`, `fe80::/10` và dạng IPv4-mapped tương ứng (HTTP 400). Không theo redirect của upstream (3xx bị coi là lỗi). `/api/fetch-image` giới hạn 50 MB mỗi ảnh.

### Triển khai công khai

1. Chạy server với `HOST=0.0.0.0` (hoặc dùng Docker, trong container `HOST=0.0.0.0` sẵn).
2. Đặt sau reverse proxy có **HTTPS** (Caddy, nginx, Traefik...). Không mở cổng HTTP thuần ra Internet, vì API key đi qua đường truyền này. `compose.yaml` chỉ publish cổng trên `127.0.0.1`, nên cần reverse proxy trỏ về `127.0.0.1:5173` (hoặc đổi mapping cổng nếu proxy chạy ở máy khác).
3. Không bật log request chứa body ở reverse proxy.

### ALLOW_PRIVATE_UPSTREAM

Đặt `ALLOW_PRIVATE_UPSTREAM=1` để tắt kiểm tra địa chỉ riêng/nội bộ, dùng khi chạy cục bộ và cần gọi API ở `localhost` hoặc mạng LAN (ví dụ `ALLOW_PRIVATE_UPSTREAM=1 npm start`). **Không đặt biến này trên server công khai.** Kiểm tra `user:pass@` và việc không theo redirect luôn bật.

## Docker

```bash
docker compose up -d --build
```

Mở http://localhost:5173. Đổi cổng trên máy host bằng `PORT=8080 docker compose up -d`. Cổng chỉ được publish trên `127.0.0.1` nên chỉ máy bạn truy cập được.

- Image dựa trên `node:22-alpine`, chỉ chứa `package.json`, `server.js` và `public/`, chạy bằng user `node`.
- Trong container `HOST=0.0.0.0` (bắt buộc để Docker publish cổng); việc giới hạn truy cập do `compose.yaml` đảm nhiệm.
- Có `HEALTHCHECK` gọi `/`; xem trạng thái bằng `docker compose ps`.
- Không có API key hay file `.env` nào trong image; bạn nhập key trên giao diện.
- Dừng và xoá: `docker compose down`.

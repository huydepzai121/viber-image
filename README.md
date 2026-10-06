# Viber Image Studio

Ứng dụng web cục bộ để tạo ảnh qua API tương thích OpenAI (`/v1/images/generations`): nhập Base URL, API key, model và prompt, xem kết quả, rồi tải ảnh về dạng PNG.

## Yêu cầu

- Node.js 20 trở lên (dùng `fetch` toàn cục và `node:test`)
- Không có dependency, không cần `npm install`, không cần build

## Chạy

```bash
npm start
```

Mở http://127.0.0.1:5173. Đổi cổng bằng biến môi trường `PORT` (ví dụ `PORT=8080 npm start`). Biến `HOST` quyết định địa chỉ lắng nghe, mặc định `127.0.0.1` (chỉ máy bạn truy cập được).
Giao diện có hai chế độ sáng/tối: mặc định theo hệ điều hành, nút ở góc phải thanh tiêu đề để đổi và lựa chọn được lưu trên trình duyệt.

## Kiểm thử

```bash
npm test
```

## Cách hoạt động

Trình duyệt gửi yêu cầu tới server cục bộ (`POST /api/generate`), server chuyển tiếp lên API và trả về nguyên trạng status, content-type và nội dung phản hồi. Nhờ vậy không bị chặn bởi CORS. Vì API hiện chỉ chấp nhận `n`=1, khi chọn n > 1 server gửi n request song song (mỗi request `n`=1) rồi gộp kết quả; nếu một request lỗi thì trả về nguyên trạng lỗi đầu tiên. Ảnh dạng URL được tải về qua `GET /api/fetch-image?url=...`. Xem mục [Bảo mật & quyền riêng tư](#bảo-mật--quyền-riêng-tư) về những gì server không bao giờ lưu.

### Base URL

Chỉ cần nhập địa chỉ gốc, ví dụ `https://bedrock.viber.vn`. Ứng dụng tự thêm `/v1/images/generations`. Dấu `/` ở cuối và đuôi `/v1/images/generations` (nếu bạn dán cả đường dẫn đầy đủ) được tự động loại bỏ để không bị lặp. Để trống sẽ dùng mặc định `https://bedrock.viber.vn`. Endpoint đầy đủ hiển thị ngay dưới ô nhập.

### Chỉnh sửa ảnh và ảnh tham chiếu

- **Chỉnh sửa**: bấm (hoặc Enter/Space) vào một ảnh kết quả để mở hộp thoại "Chỉnh sửa ảnh", nhập "Mô tả chỉnh sửa" rồi bấm "Chỉnh sửa". Server chuyển yêu cầu tới `POST /v1/images/edits` (multipart) bằng `POST /api/edit`. Có thể đính thêm tối đa 3 ảnh tham chiếu ngay trong hộp thoại.
- **Ảnh tham chiếu khi tạo**: dưới ô prompt, "Đính kèm ảnh" (chọn file, kéo thả vào thẻ prompt hoặc dán từ clipboard). Tối đa 4 ảnh PNG/JPEG/WEBP, mỗi ảnh ≤ 20 MB, tổng dung lượng giới hạn bởi request 30 MB (ảnh được mã hoá base64 nên tối đa khoảng 21 MB ảnh gốc). Có ảnh đính kèm thì "Tạo ảnh" gọi `/api/edit` (n > 1 vẫn được chia thành n request song song); ảnh đính kèm bị xoá sau khi thành công và được giữ lại nếu lỗi.
- Upstream gửi nhiều ảnh qua field lặp `image[]`; server luôn dùng `image[]`.
- Kết quả nằm trong một **feed theo phiên** (mới nhất ở trên) chỉ giữ trong bộ nhớ trang, không lưu vào localStorage hay server; nút "Xoá tất cả" giải phóng bộ nhớ.

### Tiến độ ước tính

Upstream không trả tiến độ thật, nên phần trăm trên khung chờ chỉ là **ước lượng theo thời gian**: tăng dần và tiến về 95% trong khoảng thời gian dự kiến (60 giây khi tạo thường, 70 giây khi chỉnh sửa hoặc dùng tới 2 ảnh tham chiếu, cộng 15 giây cho mỗi ảnh thêm), không bao giờ chạm 100% trước khi có phản hồi, rồi hiện 100% ngắn trước khi thay bằng ảnh. Khi hệ điều hành bật "giảm chuyển động", các chấm không chuyển động nhưng phần trăm vẫn cập nhật.

### Tên file tải về

- Một ảnh: `img_YYYYMMDD_HHMMSS.png`
- Nhiều ảnh: `img_YYYYMMDD_HHMMSS_1.png`, `_2.png`, ... (giờ địa phương lúc nhận phản hồi)

## Bảo mật & quyền riêng tư

Ứng dụng được thiết kế để có thể chạy công khai mà không thu thập thông tin của người dùng:

- **Không thu thập, không lưu, không ghi log.** Server chỉ chuyển tiếp API key, Base URL và prompt tới API bạn chỉ định rồi quên ngay: không ghi file, không ghi log, không đưa chúng vào thông báo lỗi (URL và key bị che trong lỗi 502). Log duy nhất là dòng khởi động `Viber Image Studio: http://host:port`.
- **API key chỉ lưu trên trình duyệt khi bạn đồng ý.** Ô "Ghi nhớ API key trên trình duyệt này" mặc định tắt: key chỉ nằm trong bộ nhớ của tab và mất khi tải lại trang; key đã lưu trước đó bị xoá khỏi `localStorage`. Khi bật, key được lưu trong `localStorage` (khóa `viber-image-settings`) của chính trình duyệt đó; bỏ chọn sẽ xoá lại. Base URL, model, prompt, kích thước và số ảnh vẫn được nhớ. Mọi script cùng origin đọc được `localStorage`, nên chỉ bật tuỳ chọn này trên máy tin cậy.
- **Header bảo mật** trên mọi response: `Content-Security-Policy` chặt (chỉ script/connect cùng origin, không inline script/style), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`; các endpoint `/api/*` có thêm `Cache-Control: no-store`.
- **Chống biến server thành open proxy (SSRF).** `/api/generate`, `/api/edit` và `/api/fetch-image` chỉ nhận `http`/`https`, từ chối URL có `user:pass@`, phân giải tên miền và từ chối địa chỉ loopback, mạng riêng (10/8, 172.16/12, 192.168/16), link-local (169.254/16, gồm metadata của cloud), CGNAT (100.64/10), `0.0.0.0/8`, multicast, IPv6 `::1`, `fc00::/7`, `fe80::/10` và dạng IPv4-mapped tương ứng (HTTP 400). Không theo redirect của upstream (3xx bị coi là lỗi). `/api/fetch-image` giới hạn 50 MB mỗi ảnh.

### Triển khai công khai

1. Chạy server với `HOST=0.0.0.0` (hoặc dùng Docker, trong container `HOST=0.0.0.0` sẵn).
2. Đặt sau reverse proxy có **HTTPS** (Caddy, nginx, Traefik...). Không mở cổng HTTP thuần ra Internet, vì API key đi qua đường truyền này. Khi đã có reverse proxy, chạy `BIND=127.0.0.1 docker compose up -d` (hoặc ghi `BIND=127.0.0.1` vào file `.env`) để cổng 5173 chỉ mở trong máy, rồi trỏ proxy về `127.0.0.1:5173`.
3. Không bật log request chứa body ở reverse proxy.
4. Cho phép body tới 32 MB (chỉnh sửa ảnh và ảnh tham chiếu được gửi dạng base64, tối đa 30 MB) và thời gian chờ đủ lâu (sửa nhiều ảnh có thể mất hơn 2 phút). Nếu không, reverse proxy sẽ trả `413 Request Entity Too Large` hoặc `504`.

Cấu hình nginx mẫu (sau đó chạy `certbot --nginx -d your-domain.com --redirect` để bật HTTPS):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name your-domain.com;

    client_max_body_size 32m;
    access_log off;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
```

### Chặn địa chỉ nội bộ

Server luôn từ chối Base URL hoặc URL ảnh trỏ tới `localhost`, mạng LAN/riêng (10.x, 172.16–31.x, 192.168.x), link-local/metadata cloud (169.254.x), IPv6 nội bộ, URL có `user:pass@`, và không theo redirect. Không có biến môi trường nào tắt được kiểm tra này, nên ứng dụng không dùng được với API chạy ở `localhost`/LAN.

## Docker

```bash
docker compose up -d --build
```

Mở http://localhost:5173. Đổi cổng trên máy host bằng `PORT=8080 docker compose up -d`. Mặc định cổng mở trên mọi địa chỉ (`0.0.0.0`) nên truy cập được qua IP public của server, ví dụ `http://<IP-server>:5173` (nhớ mở cổng 5173 ở firewall/security group). Biến `BIND` chọn địa chỉ publish, ví dụ `BIND=127.0.0.1` để chỉ máy server truy cập được. Truy cập qua HTTP thuần thì API key đi qua mạng không mã hoá; chạy lâu dài nên đặt sau HTTPS.

- Image dựa trên `node:22-alpine`, chỉ chứa `package.json`, `server.js` và `public/`, chạy bằng user `node`.
- Trong container `HOST=0.0.0.0` (bắt buộc để Docker publish cổng); địa chỉ publish ra ngoài do biến `BIND` trong `compose.yaml` quyết định.
- Có `HEALTHCHECK` gọi `/`; xem trạng thái bằng `docker compose ps`.
- Không có API key hay file `.env` nào trong image; bạn nhập key trên giao diện.
- Dừng và xoá: `docker compose down`.

### HTTPS với tên miền (Caddy)

Trỏ bản ghi DNS `A` của tên miền về IP server, mở cổng 80 và 443 (TCP, và UDP 443 cho HTTP/3) ở firewall/security group, rồi chạy:

```bash
echo "DOMAIN=your-domain.com" > .env
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

- Caddy tự lấy và gia hạn chứng chỉ Let's Encrypt, chuyển HTTP sang HTTPS và chuyển tiếp tới app. Chứng chỉ lưu trong volume `caddy_data`.
- Ở chế độ này app không publish cổng 5173 ra ngoài; chỉ Caddy truy cập được nó qua mạng nội bộ của Docker. Có thể đóng cổng 5173 ở firewall.
- Xem log: `docker compose -f compose.yaml -f compose.https.yaml logs -f caddy`.
- Caddy không ghi log nội dung request, nên API key không xuất hiện trong log.

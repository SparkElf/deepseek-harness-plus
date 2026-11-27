# MinerU 解析服务（内网离线部署）

一个自包含的 Docker 镜像 + 一个 compose 文件，客户内网只需 `docker compose up -d`。
镜像里已经包含 Python 依赖和全部模型权重，**运行期不访问外网**。

## 为什么是 CPU / ONNX，而不是 paddle

MinerU **4.x 不使用 paddle**。3.x 时代用 PaddleOCR，4.x 改为 ONNX 模型 + `onnxruntime`
（`pip show mineru` 的依赖里是 `onnxruntime`；`mineru-kit models download --small-backend`
只接受 `auto|onnx|torch`）。所以这里没有 `paddlepaddle` / `paddleocr`：装进去会是几百 MB
永远不被调用的死重量。CPU 保证由三件事落实：

- 用 `onnxruntime`（本镜像里是 CPU 版，不含 CUDA provider）；
- `CUDA_VISIBLE_DEVICES=""`、`USE_GPU=false`；
- 选 `basic` tier，其模型就是 ONNX 那套。

## 一、有网机器：构建

```bash
cd packages/knowledge-base/deploy/mineru
docker build -t mineru:4.0.12-cpu .
```

构建会做两件耗时的事：装依赖（约 200 MB wheel）和下载 `basic` 模型的 ONNX 权重
（约 820 MB）。整体明显受网速影响。

如果这台机器连不上 `files.pythonhosted.org`（常见：能开 pypi.org 但下载 CDN 超时），
改用国内镜像：

```bash
docker build -t mineru:4.0.12-cpu \
  --build-arg PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple \
  --build-arg PIP_TRUSTED_HOST=mirrors.aliyun.com .
```

模型源也可换：默认 `--source modelscope`；在能直连 HuggingFace 的机器上把它改成
`huggingface` 会快很多（改 Dockerfile 里 `mineru-kit models download` 那一行）。

## 二、导出与搬运

```bash
docker save mineru:4.0.12-cpu -o mineru-4.0.12-cpu.tar
# 约 6.5 GB，建议先看 sha256 再拷
sha256sum mineru-4.0.12-cpu.tar
```

把 `mineru-4.0.12-cpu.tar` 与 `docker-compose.yml` 一起拷进内网（移动硬盘 / 堡垒机 / 内网
FTP 都行）。

## 三、内网机器：导入并启动

```bash
docker load -i mineru-4.0.12-cpu.tar
docker compose up -d
docker compose ps           # 等 STATUS 出现 (healthy)
```

默认发布在宿主 `8000` 端口。要换端口只改 compose 里 `ports:` 的左边：

```yaml
ports:
  - "9000:8000"   # 宿主 9000 → 容器 8000
```

容器内部始终监听 8000，不要改右边。

## 四、验证

最小验证（就是知识库插件实际发送的请求）：

```bash
curl -X POST \
  "http://127.0.0.1:8000/v1/file_parse?tier=basic&output_formats=markdown&ocr_mode=auto" \
  -F "files=@sample.pdf"
```

注意三个容易写错的地方，它们正是旧文档与真实契约的差异：

1. **选项在 query 串里**，不在表单字段里。MinerU 4.x 以 `max_fields=0` 解析 multipart，
   表单里多一个字段会直接报 `Too many fields. Maximum number of fields is 0.`；
2. **字段名是 `files`**，不是 `file`；
3. **`output_formats` 没有默认值**，必须显式传 `markdown`。

小文件同步返回 `200`，正文在 `files[].content.markdown`。大文件返回 `202` + `task_id`，
需要轮询 `GET /v1/tasks/<task_id>`；任务体里 `content` 为 `null`，正文要按
`files[].output_files.markdown.file_id` 再取 `GET /v1/files/<file_id>/content`。
（475 页扫描件在 CPU 上约 20 分钟，属于正常。）

用仓库里的脚本验证更省事，它会自己处理这三种情况并打印正文前几行：

```bash
node ../../scripts/deploy-mineru.mjs verify --url http://127.0.0.1:8000
node ../../scripts/deploy-mineru.mjs verify --url http://127.0.0.1:8000 --file ./sample.pdf
```

## 五、填进知识库设置

部署完成后，把服务地址填到知识库设置 → MinerU 服务地址：

```
http://<内网机器 IP>:8000
```

## 镜像体积

约 **6.5 GB**：

| 组成 | 约 |
|---|---|
| 基础镜像（Debian + Python 3.11 + libGL 等） | 1.2 GB |
| Python 依赖（onnxruntime、pydantic、gradio 等 110+ 包） | 2.5 GB |
| `basic` tier ONNX 模型（Layout/MFR/OCR/Table） | 820 MB |
| 其余系统层与解压开销 | 2.0 GB |

如果嫌大，可选：

- 分卷不现实（镜像是单层集合），更实际的是**把模型做成独立卷**：删掉 Dockerfile 里
  `COPY models/...` 那行，改用 compose 里的 `- ./models:/root/.mineru/models:ro`
  挂载，模型单独拷贝。镜像降到约 5.6 GB，但搬运多一步。
- 不需要 WebUI 的话，`mineru` 的 `gradio` 依赖占 ~300 MB，可用
  `pip install --no-deps` 加手工依赖清单裁掉，代价是镜像不再是"官方依赖集"，升级易碎。

## 已知限制

- **CPU only**：475 页扫描件约 20 分钟；生产建议限制单文件页数或加并发队列。
- `basic` tier 不含 VLM 增强（公式/复杂版面精度低于 `standard`）。
- 镜像里没有 `paddle`，这是设计而非缺失（见文首）。

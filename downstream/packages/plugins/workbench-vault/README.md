# @sparkelf/dsh-workbench-vault

Host-only encrypted credential storage shared by Workbench plugins. Browser and model-tool surfaces can set, replace, test, or delete a credential through their owning plugin, but they never receive decrypted values. Records are isolated by namespace and encrypted with AES-256-GCM using an independent owner-only key.

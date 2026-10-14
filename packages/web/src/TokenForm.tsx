import { useState, type FormEvent } from "react";

export interface TokenFormProps {
  /** 上一次失敗的原因（例如 401）；沒有時為 null。 */
  message: string | null;
  onSubmit: (token: string) => void;
}

/**
 * token 輸入畫面：使用者從服務啟動處貼上 token。
 * token 只交給 `onSubmit`，不寫進 URL、不寫進任何會被 build 內嵌的地方。
 */
export function TokenForm({ message, onSubmit }: TokenFormProps) {
  const [value, setValue] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const token = value.trim();
    if (token === "") return;
    onSubmit(token);
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-ink">Mnemoshelf</h1>
        <p className="text-sm text-muted">
          請貼上服務的存取 token。token 只保留在這個分頁的記憶體工作階段中，不會寫進網址或磁碟。
        </p>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <label htmlFor="mnemoshelf-token" className="block text-sm font-medium text-ink">
          存取 token
        </label>
        <input
          id="mnemoshelf-token"
          name="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="貼上 MNEMOSHELF_TOKEN"
          className="w-full rounded-md border border-line bg-white px-3 py-2 font-mono text-sm text-ink outline-none focus:border-ink"
        />
        {message !== null && (
          <p role="alert" className="text-sm text-red-600">
            {message}
          </p>
        )}
        <button
          type="submit"
          disabled={value.trim() === ""}
          className="w-full rounded-md bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          連線
        </button>
      </form>

      <p className="text-xs text-muted">
        啟動服務時若未設定 token，服務會直接啟動失敗。可用 <code>openssl rand -hex 32</code> 產生一組。
      </p>
    </div>
  );
}

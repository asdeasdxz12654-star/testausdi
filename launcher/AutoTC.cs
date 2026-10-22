// AutoTC.exe 런처. 프로젝트 폴더에서 node scripts/start.js 를 실행하고, 콘솔 창에 진행 상황을 보여준다.
// 빌드: npm run build:exe (Windows 기본 .NET Framework 컴파일러 csc.exe 사용)
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

class AutoTcLauncher
{
    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.Title = "AutoTC";

        string root = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(root, "scripts", "start.js");
        if (!File.Exists(script))
        {
            return Fail("scripts\\start.js 파일을 찾을 수 없습니다. AutoTC.exe는 AutoTC 프로젝트 폴더 안에 두고 실행하세요.");
        }

        string node = FindNode();
        if (node == null)
        {
            return Fail("Node.js가 설치되어 있지 않습니다.\nhttps://nodejs.org 에서 LTS 버전(20 이상)을 설치한 뒤 다시 실행하세요.");
        }

        var arguments = new StringBuilder("\"" + script + "\"");
        foreach (string a in args) arguments.Append(" \"").Append(a.Replace("\"", "\\\"")).Append("\"");

        var psi = new ProcessStartInfo(node, arguments.ToString())
        {
            UseShellExecute = false,
            WorkingDirectory = root,
        };
        try
        {
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                if (p.ExitCode != 0)
                {
                    return Fail("AutoTC가 오류로 종료되었습니다 (코드 " + p.ExitCode + "). 위 메시지를 확인하세요.", p.ExitCode);
                }
                return 0;
            }
        }
        catch (Exception e)
        {
            return Fail("Node.js를 실행하지 못했습니다: " + e.Message);
        }
    }

    static string FindNode()
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(Path.PathSeparator))
        {
            try
            {
                string candidate = Path.Combine(dir.Trim().Trim('"'), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) { }
        }
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string fallback = Path.Combine(programFiles, "nodejs", "node.exe");
        return File.Exists(fallback) ? fallback : null;
    }

    static int Fail(string message, int code = 1)
    {
        Console.WriteLine();
        Console.WriteLine("[AutoTC] " + message);
        Console.WriteLine("Enter 키를 누르면 창이 닫힙니다.");
        Console.ReadLine();
        return code;
    }
}

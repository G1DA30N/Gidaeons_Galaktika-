using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

public static class NativeHostLauncher
{
  private static readonly string NativeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
  private static readonly string HostScript = Path.Combine(NativeDir, "native_host.py");
  private static readonly string StderrLog = Path.Combine(NativeDir, "helper.stderr.log");

  private static int Main()
  {
    try
    {
      string python = FindPython();
      if (String.IsNullOrEmpty(python))
      {
        File.AppendAllText(StderrLog, "Python was not found for the Galaktika native host." + Environment.NewLine);
        return 1;
      }

      ProcessStartInfo startInfo = new ProcessStartInfo();
      startInfo.FileName = python;
      startInfo.Arguments = "-u " + Quote(HostScript);
      startInfo.WorkingDirectory = Directory.GetParent(NativeDir).FullName;
      startInfo.UseShellExecute = false;
      startInfo.CreateNoWindow = true;
      startInfo.RedirectStandardInput = false;
      startInfo.RedirectStandardOutput = false;
      startInfo.RedirectStandardError = true;

      using (Process process = Process.Start(startInfo))
      {
        Thread errorThread = new Thread(delegate()
        {
          try
          {
            using (FileStream log = new FileStream(StderrLog, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
            {
              CopyStream(process.StandardError.BaseStream, log);
            }
          }
          catch { }
        });
        errorThread.IsBackground = true;

        errorThread.Start();
        process.WaitForExit();
        return process.ExitCode;
      }
    }
    catch (Exception ex)
    {
      Log("Native launcher failed: " + ex);
      return 1;
    }
  }

  private static void CopyStream(Stream source, Stream destination)
  {
    byte[] buffer = new byte[64 * 1024];
    while (true)
    {
      int read = source.Read(buffer, 0, buffer.Length);
      if (read <= 0) break;
      destination.Write(buffer, 0, read);
      destination.Flush();
    }
  }

  private static string FindPython()
  {
    string helperPython = Path.Combine(NativeDir, ".venv", "Scripts", "python.exe");
    if (File.Exists(helperPython)) return helperPython;

    string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    string[] candidates = new string[]
    {
      Path.Combine(localAppData, "Programs", "Python", "Python314", "python.exe"),
      Path.Combine(localAppData, "Programs", "Python", "Python313", "python.exe"),
      Path.Combine(localAppData, "Programs", "Python", "Python312", "python.exe")
    };

    foreach (string candidate in candidates)
    {
      if (File.Exists(candidate)) return candidate;
    }
    return FindOnPath("python.exe");
  }

  private static string FindOnPath(string fileName)
  {
    string path = Environment.GetEnvironmentVariable("PATH") ?? "";
    foreach (string part in path.Split(Path.PathSeparator))
    {
      if (String.IsNullOrWhiteSpace(part)) continue;
      string candidate = Path.Combine(part.Trim(), fileName);
      if (File.Exists(candidate)) return candidate;
    }
    return "";
  }

  private static string Quote(string value)
  {
    return "\"" + value.Replace("\"", "\\\"") + "\"";
  }

  private static void Log(string message)
  {
    try { File.AppendAllText(StderrLog, message + Environment.NewLine); }
    catch { }
  }
}

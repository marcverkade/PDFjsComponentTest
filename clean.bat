rd /s /q "C:\Development\DotNet10\PDFjsComponentTest\PDFjsComponentTest\PDFjsComponentTest\obj"
rd /s /q "C:\Development\DotNet10\PDFjsComponentTest\PDFjsComponentTest\PDFjsComponentTest/bin"
rd /s /q "C:\Development\DotNet10\PDFjsComponentTest\PDFjsComponentTest\PDFjsComponentTest.Client\obj"
rd /s /q "C:\Development\DotNet10\PDFjsComponentTest\PDFjsComponentTest\PDFjsComponentTest.Client\bin"

echo Is Visual Studio Closed so Cache etc. can be deleted?
pause
echo Sure???
pause

del /Q C:\Users\Mitcon\AppData\Local\Microsoft\VisualStudio\18.0_70d1ce3a\ComponentModelCache\*.*
del /S /Q C:\Users\Mitcon\AppData\Local\Microsoft\VisualStudio\Roslyn\Cache\*.*
del /S /Q C:\Users\Mitcon\AppData\Local\Temp\*.*
rmdir /s /q C:\Development\DotNet10\PDFjsComponentTest\.vs

echo Done...
pause
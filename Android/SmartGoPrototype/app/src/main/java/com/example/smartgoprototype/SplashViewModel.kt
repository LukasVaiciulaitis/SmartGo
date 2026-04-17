package com.example.smartgoprototype

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.smartgoprototype.data.auth.SessionProvider
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Drives the splash screen by fetching the auth session once.
 *
 * Using SessionProvider.getIdToken here serves two purposes:
 *  1. Determines whether the user is already signed in.
 *  2. Warms the token cache so AuthInterceptor never hits its runBlocking fallback
 *     when the first batch of API calls fires immediately after navigating to the Dashboard.
 */
@HiltViewModel
class SplashViewModel @Inject constructor(
    private val sessionProvider: SessionProvider
) : ViewModel() {

    private val _destination = MutableStateFlow<String?>(null)
    val destination: StateFlow<String?> = _destination

    init {
        viewModelScope.launch {
            val token = runCatching { sessionProvider.getIdToken() }.getOrNull()
            _destination.value = if (!token.isNullOrBlank()) Routes.DASHBOARD else Routes.LOGIN
        }
    }
}
